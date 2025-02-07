function migrate (master) {
    var m = master.get('migrations')
    if (!m.to_bus7) {
        function move_into_val (obj) {
            console.assert(!obj.val, 'Obj already has val! ' + JSON.stringify(obj))
            obj.val = {}
            for (k in obj) {
                if (k !== 'key' && k !== 'val') {
                    obj.val[k] = obj[k]
                    delete obj[k]
                }
            }
        }
        
        function move_arr_to_val (key) {
            var obj = master.cache[key],
                keys = Object.keys(obj)
            console.assert((keys.length === 2 && Array.isArray(obj.arr)),
                           'Not an arr thing: ' + key + ' '
                           + JSON.stringify({keys: keys.length === 2,
                                             array: Array.isArray(obj.arr)}))
            obj.val = obj.arr
            delete obj.arr
            master.set(obj)
        }

        function move_tags (obj) {
            if (obj.val.tags) {
                master.set({
                    key: 'tags/' + obj.key,
                    val: obj.val.tags
                })
                delete obj.val.tags
            }
        }

        function linkify_key (obj, from, to) {
            if (obj.val[from]) {
                obj.val[to] = {link: obj.val[from]}
                delete obj.val[from]
            }
        }

        function recursive_linkify (key) {
            var obj = master.cache[key]
            if (obj.val)
                master.deep_map(obj.val, (obj) => {
                    if (obj && typeof(obj) === 'object' && obj.key)
                        return {link: obj.key}
                    else
                        return obj
                })
        }

        // Convert each user
        var users = master.get('users')
        users.all.forEach(u => {
            move_into_val(u)
            move_tags(u)
            master.set(u)
        })

        // Convert the users list
        users.val = users.all.map(user => ({link: user.key}))
        delete users.all
        master.set(users)

        // Convert users/passwords
        var user_passes = master.get('users/passwords')
        move_into_val(user_passes)
        master.set(user_passes)
        console.log('Now user_passes is', user_passes)

        // Convert votes
        Object.keys(master.cache)
            .filter(k => k.includes('/vote/'))
            .forEach(k => {
                // Convert vote

                var vote = master.cache[k],
                    keys = Object.keys(vote)

                // Move everything to .val
                move_into_val(vote)

                // Sanity check fields
                if (!vote.val.user_key || !vote.val.target_key) {
                    console.error('Missing user_key or target_key on', vote)
                    return
                }

                // Convert keys to links, and rename fields
                linkify_key(vote, 'user_key', 'from')
                linkify_key(vote, 'target_key', 'to')
                vote.val.amount = vote.val.value
                delete vote.val.value

                // Convert depth > 1 to computed: true
                var depth = vote.val.depth
                if (depth > 1)
                    vote.val.computed = true
                delete vote.val.depth

                // Convert untagged to .tag = 'null'
                if (vote.val.tag === undefined
                    || vote.val.tag === null)
                    vote.val.tag = 'null'

                // Delete a vote with depth=0
                if (depth === 0)
                    master.del(k)

                // Else Save
                else
                    master.set(vote)
            })

        // Convert '*votes*'
        Object.keys(master.cache)
            .filter(k => k.includes('votes'))
            .filter(k => !k.includes('votes_'))
            .filter(k => !k.includes('votes/_'))
            .filter(k => !k.includes('tag:votes'))
            .forEach(move_arr_to_val)

        // Convert posts
        Object.keys(master.cache)
            .filter(k => k.startsWith('post'))
            .filter(k => !k.startsWith('posts'))
            .filter(k => !k.includes('comment'))
            .forEach(k => {
                var obj = master.cache[k],
                    keys = Object.keys(obj)

                // Move everything to .val
                move_into_val(obj)

                // Move tags
                move_tags(obj)

                // Linkify
                linkify_key(obj, 'user_key', 'from')
            })

        // Convert posts*
        Object.keys(master.cache)
            .filter(k => k.startsWith('posts'))
            .forEach(move_arr_to_val)

        // Convert all nested keys to links
        Object.keys(master.cache)
            .forEach(recursive_linkify)

        console.log('Bus7 MUTATIONS completed!  Now processing deletes.')
        master.set(m)

        // Now let's analyze all the categories of keys
        var patterns = {
            // default: /^@default/,
            junk_votes1: /^votes\/_.*/,
            junk_votes2: /^votes_.*/,
            vote: /^@[^/]+\/vote\/.*$/,
            decached_people_votes: /\/votes\/people/,
            user_votes: /^@[^/]+\/votes.*$/,
            votes_on: /^votes\//,
            weights: /^weights\//,
            user: /^@[^/]+$/,
            post: /^post\/.*$/,
            posts: /^posts(\(.+\))?/,
            user_posts: /^@[^/]+\/posts/,
            tags: /^tags\//
        }

        var result = {
            ...Object.fromEntries(Object.keys(patterns).map(k => [k, []])),
            none: []
        }

        for (var key in master.cache) {
            var matched = false
            for (var category in patterns)
                if (patterns[category].test(key)) {
                    result[category].push(key)
                    matched = true
                    break
                }
            if (!matched) result.none.push(key)
        }

        // console.log(result)
        // process.exit(0)

        // // print them out
        // for (var category in result) {
        //     if (category !== 'decached_people_votes') continue
        //     console.log('### ' + category)
        //     result[category].forEach(x => console.log(x))
        //     console.log('\n\n')
        // }

        // Delete the keys that suck
        var canceled_categories = [
            'junk_votes1',
            'junk_votes2',
            'weights',
            'posts',
            'decached_people_votes',
            'user_posts'
        ]
        console.log('Now deleting the canceled categories', canceled_categories)

        canceled_categories.forEach(cat =>
            result[cat].forEach(key =>
                master.del(key)
            )
        )

        console.log('MIGRATION ompleted to_bus7.')
        m.to_bus7 = true
        master.set(m)

    }
}

module.exports = migrate
