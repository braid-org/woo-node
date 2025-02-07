// I think all these things have to be defined before 
var unslash = t => t?.startsWith?.("/") ? t.substr(1) : t
var slash = t => t?.startsWith?.("/") ? t : `/${t}`
var split_once = (str, char) => {
    var i = str.indexOf(char)
    return i === -1 ? [str, ""] : [str.slice(0, i), str.slice(i + 1)]
}

// KSON = Kinda Simple Object Notation
// but it rhymes with JSON
var parse_kson = str => {
    // assert str.startsWith "(" and str.endsWith ")"

    // Coffeescript doesn't have object comprehensions :(
    var ret = {}
    str.slice(1, -1)  // Pull out the parentheses
        .split(",")   // Split by commas. TODO: Allow spaces after commas?
        .filter(part => part.length)  // Delete empty parts (this ensures that empty strings will properly result in empty KSON, and allows trailing commas)
        .forEach(part => {
            // If the part has a comma, its a key:value, otherwise it's just a singleton
            var [k, v] = split_once(part, ":")
            
            if (v.length === 0) ret[k] = true
            // If the value is itself a KSON object, parse it recursively
            else if (v.startsWith("(")) ret[k] = parse_kson(v)
            else ret[k] = v
        })
    return ret
}

var stringify_kson = obj => {
    var inner = Object.entries(obj)
        // Allowed values in KSON are: object, string, true
        // Arrays are in fact objects, and we don't need to treat them differently.
        // Their order won't change!
        .filter(([k, v]) => v)
        .sort()
        .map(([k, v]) => {
            if (typeof v === "boolean") return k
            if (typeof v === "string") return `${k}:${v}`
            if (typeof v === "object") return `${k}:${stringify_kson(v)}`
            return ""
        })
        .join(",")
    return inner.length ? `(${inner})` : ""
}

// Pattern: looks something like `const/<args1>/...`
// Star: looks something like `a/b/c/d(params:etc)`
var match_pattern = (pattern, star) => {
    // First separate out the params, as raw KSON
    var [star, params_raw] = split_once(star, "(")
    
    // Now we need to determine if star matches the pattern
    var star_parts = star.split("/")
    var pattern_parts = pattern.split("/")
    // Quick length check
    if (star_parts.length !== pattern_parts.length)
        return false

    // Once again... no object comprehension, or zip()
    var path = {}
    for (var i = 0; i < pattern_parts.length; i++) {
        var ppart = pattern_parts[i]
        var spart = star_parts[i]
        
        // we either match an argument (if ppart is of the form <keyN>) or we verify that the constants are equal
        if (ppart.startsWith("<")) 
            path[ppart.slice(1, -1)] = spart
        else if (ppart !== spart)
            return false
    }

    // split_once will take off the parenthese if it exists, let's put it back on
    var params = params_raw.length ? parse_kson(`(${params_raw}`) : {}
    return {path, params}
}

var autodetect_args = handler => {
    if (handler.args) return

    // Get an array of the handler's params
    var comments = /((\/\/.*$)|(\/\*[\s\S]*?\*\/))/mg
    var params = /([^\s,]+)/g
    var s = handler.toString().replace(comments, '')

    var param_list = s.slice(s.indexOf('(') + 1, s.indexOf(')')).match(params) || []

    handler.args = {}
    param_list.forEach((p, i) => {
        switch (p) {
            case "key": case "k": 
                handler.args.key = i; break
            case "json": case "vars":
                handler.args.vars = i; break
            case "star": case "rest":
                handler.args.res = i; break
            case "t": case "transaction":
                handler.args.t = i; break
            case "o": case "obj": case "val": case "new": case "New":
                handler.args.obj = i; break
            case "old":
                handler.args.old = i; break
        }
    })
}

// Pattern-Path-Params Parser
var upgrade_bus = bus => {
    // Create arrays to store the fetch and save handlers
    var handlers = {
        to_get: [],
        to_set: [],
        on_set: [],
        on_set_sync: [],
        on_delete: [],
        to_delete: [],
        to_forget: []
    }

    var og_route = bus.route
    bus.route = (key, method, arg, t) => {
        for (var route of (handlers[method] || [])) {
            var {pattern, handler} = route
            var match = match_pattern(pattern, key)
            if (match) {
                var {path, params} = match
                // For the time being, we are able to sneak in arguments on the transaction
                // If we run into issues with that, the solution is simply to have the handler access `key` and reparse it
                // Since it knows its own pattern!
                t = t || {}
                t._path = path
                t._params = params
                bus.run_handler(handler, method, arg, {t: t, binding: pattern})
                return 1
            }
        }
        return og_route(key, method, arg, t)
    }
    
    return pattern => {
        var ret = {}
        Object.entries(handlers).forEach(([method, arr]) => {
            Object.defineProperty(ret, method, {
                set: handler => {
                    autodetect_args(handler);
                    (handler.defined = handler.defined || []).push({
                        as: 'handler',
                        bus: bus,
                        method: method,
                        key: pattern
                    })
                    arr.push({pattern, handler})
                }
            })
        })
        return ret
    }
}

var exports = {slash, unslash, split_once, parse_kson, stringify_kson, match_pattern, upgrade_bus}
if (typeof window !== 'undefined')
    Object.assign(window, exports)
else
    // Nodejs
    module.exports = exports
