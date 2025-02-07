// == Definitions: ==

// Statebus variables
var master = require('statebus')(),
    mstate = master.state,
    link = master.link,
    raw = master.raw

// HTTP variables
var app = require('express')(),
    port = 3008

// Funcargs libraries are cool
var funcarg_parser = require('./parser'),
    funcarg_string = funcarg_parser.stringify_kson

// == Set things up! ==

// Create the HTTP server
var http_server = require('http').createServer()
http_server.listen(port, () => console.log('listening on', port))

// Setup the statebus!
master.http = app              // Some statebus libraries like to interact with HTTP
master.http_server = http_server
master.honk = 3                // Print handy debugging output
master.libs.file_store()       // Persist state onto disk
master.libs.serve_clientjs()
master.libs.sockjs_server(http_server)

// Migrate state
require('./migrations')(master)

// Setup express
http_server.on('request', (req, res, next) => {
    // But express must ignore all sockjs requests
    if (req.url.startsWith('/'+master.options.websocket_path+'/'))
        next()
    else
        app(req, res)
})

// Setup routs for client code
master.http.get('/', (req, res) => res.sendFile(__dirname + '/client.html'))

// Serve other state from our statebus
master.http.use(master.libs.http_in)


// == Define the Getters and Setters ==

master.custom_clients = (client, client_id) => {
    client.honk = 1

    // Setup auth
    client.serves_auth(master)

    // Shorthand for state proxy
    var cstate = client.state

    // Vote getter and setter
    client(':user/vote/*()', {

        get: (key, path, star, func_args, t) => {
            var {user} = path,
                slug = star,
                {computed, tag} = func_args

            // If the raw vote exists, return it
            var raw_vote = mstate[user + '/vote/' + slug + funcarg_string({tag})]
            if (raw_vote)
                return raw_vote

            // If the user asked for a computed vote, let's look for one
            // within his web of trust
            if (computed) {
                // Access the user's woo, and see if this computed vote is in there
                var woo = cstate[user +'/votes/'+ funcarg_string({...func_args, voters: true})]

                // Now search for the vote in there
                for (var vote of raw(woo))
                    if (vote.link === key)
                        // We found it!  Return its state.
                        return mstate[vote.link]
            }

            // Otherwise, return undefined -- 404.
            return undefined
        },

        set: (key, path, star, func_args, val, old, t) => {
            var vote = val,
                user = path.user,
                slug = star,
                {computed, tag} = func_args
                
            var curr = cstate.current_user

            // Creating a vote without a tag is equivalent to tag = "null"
            if (val.tag === null || val.tag === undefined)
                val.tag = 'null'

            var valid_schema = bus.validate(val, {
                // The main vote fields
                from: 'object',
                to: 'object',
                amount: 'number',
                tag: 'string',

                // Optional fields
                '?voter': 'boolean',
                '?computed': 'boolean',
                '?updated': 'number',
            })

            var valid_mutation = valid_schema
                 // User is authorized
                 && (curr.logged_in && raw(curr).user.link === userid
                     && userid === raw(vote).user.link)
                                  
                 // Key matches contents
                 && (slug === raw(vote).to.link)

                 // The (tag:name) matches vote.tag == name
                 && (tag ?? 'null') === vote.tag

                 // Vote is between 0 and 1
                 && (0 <= vote.value && vote.value <= 1)

                 // Don't bother trying to save a computed vote
                 && computed !== true

            // Abort if we're screwed!
            if (!valid_mutation)
                return t.abort()

            // Alright, looks good!

            // // # User votes should be given depth 1
            // // TODO: Is this still appropriate?  I'm changing depth -> computed.
            // if (val.voter)
            //     val.depth = 1

            // Now store it on master!
            mstate[key] = vote

            // If it's a new vote, add to our indices of votes!
            if (!old)
                [`${user}/votes`, `votes/${slug}`].forEach(k => {
                    // Push it onto the list
                    mstate[k] ||= []
                    mstate[k].push(link(key))
                })

            // Update indices of tags:
            //
            // 1. Add tag to master.tags index
            mstate.tags ||= []
            if (!mstate.tags.includes(tag))
                mstate.tags.push(tag)
            //
            // 2. Add tag to the specific to: object's index
            mstate['tags/' + slug] ||= []
            if (!mstate['tags/' + slug].tags.includes(tag))
                mstate['tags/' + slug].tags.push(tag)
            
            // ....and we're done!  Ship it!
            t.done(vote)
        }
    })

    function filter_votes (votes, tag, voters) {
        // Filter `votes` to just those matching `tag` and `voters`
        return votes.filter( vote =>
                voters ? vote.voter : true
                &&
                tag ? tag === vote.tag : true
        ).map(link)
    }

    // Votes from a user
    client(':user/votes()', {
        set: t => t.abort(),
        get: (key, path, func_args, t) => {
            var {user} = wildcards,
                {computed, tag, voters} = func_args
            
            // The client requests a woo by asking for the "computed voters"
            if (computed && voters)
                return compute_woo({user, tag})

            // Else, we just filter votes to the query
            var votes = mstate[user + '/votes'] || []
            return filter_votes(votes, tag, voters)
        }
    })

    // Votes on a thing
    client('votes/*()', {
        set: t => t.abort(),
        get: (key, star, func_args, t) => {
            var slug = star,
                {computed, tag, voters} = func_args

            var votes = mstate['votes/' + slug] || []
            return filter_votes(votes, tag, voters)

            // Todo: compute the woo's vote on a thing
        }
    })

    client('tags', {
        get: () => mstate.tags || [],     // Get from master; default to []
        set: t => t.abort()               // Block all writes
    })

    // // Custom user
    // client(':userid', {
    //     set: (key, val, old, t) => {
    //         if (old.joined !== val.joined)
    //             return t.abort()
    //         if (old.border !== val.border)
    //             return t.abort()
    //         master.set(val)
    //         t.done(val)
    //     }
    // })
}

master('tags', {
    default: []   // Todo: implement default in statebus
})


// master('@*', {
//     set: (key, val, old, t) => {
//         if (!old.joined)
//             val.joined = Date.now()
//     }
// })



// == Compute the WOO!!! ==

function compute_woo ({username, tag}) {
    // We'll be crawling a breadth-first path through the network, multiplying
    // each crawled path by the product of reputation of each hop.

    var MIN_WEIGHT = 0.05     // The minimum weight before we ignore a crawl path
    var MAX_DEPTH = 5         // The maximum depth we traverse in the woo

    // We calculate w(x, y): the weight of user y from the perspective
    // of user x.  This weight is computed from a breadth-first-search
    // across all paths to user y from user x.
    //
    // w(x, y) :=
    //    let l = min(minimum length of all paths x -> y, MAX_DEPTH) 
    //    let P = { p : path x -> y | length(p) = l and |Product_{j=1}^(l-1) p_j| >= MIN_WEIGHT}
    //    return Sum_{i=1}^{|P|} Product_{j=1}^l (P_i)_j
    //
    // Then we return W(x) = { y: w(x, y), ... } for all y
    //
    // Note that *votes* have their values scaled from 0 to 1, while
    // this choice of algorithm scales votes from -1 to 1

    var votes = {},
        depth = 0,         // The current depth level we are processing in BFS order

        queue_cur = {},    // The queue of users we are processing at our current depth
        queue_next = {}    // The queue of users at the next depth, that we will process next

    // Each queue is a map:
    //
    //     user -> [weight, weight, weight...]
    //
    // of all weights along the path from our starting user to the target user.

    // Initialize our queue of people to process as the current user, with a
    // path weighted at 1.0
    queue_cur[username] = [1.0]

    while (Object.keys(queue_cur).length && depth < MAX_DEPTH) {
        for (var [target, paths] of Object.entries(queue_cur)) {
            var vote_computed = depth !== 1
            var vote_key = (username + '/vote/' + target
                            + funcarg_string({computed: vote_computed, tag}))

            votes[target] = link(vote_key)

            if (vote_computed) {
                // Store the computed vote in state
                mstate[vote_key] = {
                    from: username,
                    to: target,
                    value: (w + 1) / 2,
                    voter: true,
                    computed: depth > 1,
                    tag
                }
                var w = paths.reduce((a, b) => a + b) / paths.length
            } else
                var w = 2 * mstate[vote_key].value - 1

            // Stop processing if we're into the noise
            if (Math.abs(w) <= MIN_WEIGHT)
                continue

            // Now add this voter's woo onto our upcoming traversal queue
            mstate[
                target + '/votes' + funcarg_string({tag, voters:true})
            ]

            // Skip voters we've already processed
            ?.filter(
                vote => !(vote.to in votes) && !(vote.to in queue_cur)
            )

            // Add the remaining onto our upcoming queue
            ?.forEach(
                vote => {
                    queue_next[vote.to] = queue_next[vote.to] || []
                    queue_next[vote.to].push(
                        // If a user has a negative weight:
                        //   - we record that user's weight (above)
                        //   - but end the chain here, by multiplying by zero
                        (2 * vote.value - 1) * Math.max(w, 0)
                    )
                }
            )
        }

        // We've processed all nodes at depth n. Now we'll swap our
        // buffers and process the next depth.
        queue_cur = queue_next
        queue_next = {}
        if (++depth >= MAX_DEPTH) break

        // We want to fallback a vote on the default user at depth 2,
        // so that it'll be considered computed.
        //
        // So the "naive" way would be to queue it at depth 2 if the
        // conditions are right. But we might not make it to depth 2!
        //
        // So at depth 1, if the queue is empty, we'll jump to depth 2.
        if (depth === 1 && Object.keys(queue_cur).length === 0) depth++
        
        // Now if we're at depth 2 and we don't have a depth=1 vote
        // on @default, then add mister default into our votes.
        if (depth === 2 && !("@default" in votes))
            queue_cur["@default"] = [1.0]
    }
    
    // Votes is a hash so that we can quickly check membership, but we
    // need to return an array of votes.
    return Object.values(votes).map(link)
}

