var bus = require('statebus')()
var app = require('express')()

// Create the HTTP server
require('http')
    .createServer(app)
    .listen(3007, () => console.log('listening on 3007'))

// Setup the statebus!
bus.honk = true             // Print handy debugging output
bus.libs.file_store()       // Persist state onto disk


bus.state['@toomim'] = 3



// // Install a timer.
// //
// //    Or you could use
// //    bus.libs.time()
// //
// var timeout
// bus('time', {
//     get: (t) => {
//         var f = () => t.done(Date.now())
//         timeout = setInterval(f, 1000)
//         f()
//     },
//     forget: () => clearTimeout(timeout)   // Unsubscribe
// })
    
// // Let's program some state!
// bus('what-now', {
//     get: () => bus.state.time,
//     set: (val) => bus.state.yeep = val
// })


// // Here's a value that's always 2+ another number
// bus.state.counter = 0

// bus('two-plus', {
//     get: () => bus.state.counter + 2,
//     set: (val) => bus.state.counter = val - 2
// })




// Serve other state from statebus
app.use(bus.libs.http_in)

// Other libs you might like:
// bus.libs.sqlite_store()
// bus.libs.pg_store()
// bus.libs.firebase_store()
// bus.libs.sqlite_query_server()
// bus.libs.sqlite_table_server()
// bus.libs.serve_email()


