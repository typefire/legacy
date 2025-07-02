import * as ts from 'typescript'
import {createHttpServer, HttpRequest, IServer} from "@typefire/web";
import {
    exfer,
    getImportFor,
    infer,
    ofType,
    SourceTransformerContext,
    withCall,
    createConst,
    createPropertyAccess,
    createUntypedArrow,
    createVoid0,
    toExpression
} from "@typefire/transform";
import {DbContext} from "@typefire/data/index";

withCall<typeof createHttpServer>((node, {context: {factory}}) => {
    return infer(factory, (() => {
        const routeMap = new Map()
        const GET = Symbol('GET')
        const POST = Symbol('POST')
        const ANY = Symbol('ANY')
        const server = require('node:http').createServer(async (req, res) => {
            try {
                const method = req.method === 'GET' ? GET : null
                let map = routeMap
                const params = []
                const [url, query] = req.url.split('?', 2)
                url.split('/').filter(a => a).every(a => {
                    map = map.get(a.toLowerCase()) ?? (map.has('*') ? (params.push(a), map.get('*')) : undefined)
                    return map
                })
                const config = map?.get(method) ?? map?.get(ANY)
                if (!config) {
                    res.statusCode = 404
                    return res.end(JSON.stringify({
                        message: 'Not Found'
                    }))
                }
                const body = await config.handler({
                    body: {},
                    query: query ? Array.from(new URLSearchParams(query).entries()).reverse().reduce((query, [name, value]) => {
                        query[name] = value
                        return query
                    }, {}) : {},
                    params: config.params.reduce((obj, param, i) => {
                        obj[param] = params[i]
                        return obj
                    }, {})
                })
                res.setHeader('content-type', 'application/json')
                res.end(JSON.stringify(body));
            } catch (e) {
                res.statusCode = 500;
                res.write(JSON.stringify({
                    error: true,
                    message: e.message
                }))
                res.end()
                // Handle complete failure
            }
        });

        function registerHandler(method: Symbol, route: string, handler: (request: HttpRequest<any>) => any) {
            let map = routeMap
            const params = []
            route.split('/').filter(a => a).forEach(a => {
                if (a.startsWith(':')) {
                    params.push(a.substring(1))
                    a = '*'
                }
                a = a.toLowerCase()
                let existing = map.get(a)
                if (!existing)
                    map.set(a, existing = new Map())
                map = existing
            })
            if (map.has(method))
                throw new Error(`Handler for '${method.description} ${route}' is already registered.`)
            map.set(method, {
                handler,
                params
            })
        }

        return {
            get: (route, handler) => {
                console.log('get', route, handler.toString())
                registerHandler(GET, route, handler)
            },
            post: (route, handler) => {
                console.log('post', route, handler.toString())
                registerHandler(POST, route, handler)
            },
            serve: port => {
                server.listen(port)
            }
        }
    })())
})

function parseRoute(route: string) {
    const parts = route.split('/')
    return {
        parts,
        params: parts.filter(p => p.startsWith(':')).map(p => p.substring(1))
    }
}

interface ParamConfig {
    name: string;
    tags: string[];
    primitive?: "string" | "boolean" | "number";
    symbol?: ts.Symbol;
    // allowFrom: ("uri" | "body" | "path" | "env" | "query")[];
    type?: ts.Type
    typeNode?: ts.TypeNode
    optional?: boolean
}

function getParametersForFunction({context: {checker, tags}}: SourceTransformerContext, node: ts.Node) {
    const callSignature = checker.getTypeAtLocation(node).getCallSignatures()[0]
    return callSignature.getParameters().map(symbol => {
        const param = symbol.valueDeclaration as ts.ParameterDeclaration
        const type = checker.getTypeFromTypeNode(param.type)
        const typeTags = tags.getTagTypes(param.type)
        let primitive;
        if (type) {
            if (type.flags & ts.TypeFlags.String) {
                primitive = 'string'
            } else if (type.flags & ts.TypeFlags.Number) {
                primitive = 'number'
            } else if (type.flags & ts.TypeFlags.Boolean) {
                primitive = 'boolean'
            }
        }
        const config: ParamConfig = {
            name: symbol.name,
            tags: typeTags,
            primitive: primitive as any,
            typeNode: param.type,
            optional: !!param.questionToken,
            type,
            symbol
        };
        return config
    })
}


withCall<IServer["get"]>((node, context) => {
    const {context: {factory, tags, checker}} = context
    const route = parseRoute((node.arguments[0] as ts.StringLiteral).text)
    const parameters = getParametersForFunction(context, node.arguments[1])
    const map: ({ from: 'string' | 'string[]', to: ParamConfig, access: ts.Expression } | undefined)[] = []
    const queryVars: ParamConfig[] = []
    const paramVars: ParamConfig[] = []
    parameters.forEach((a, i) => {
        if (!ofType<DbContext>(context, a.typeNode)) {
            if (route.params.includes(a.name)) {
                paramVars.push(a)
                map[i] = {
                    from: 'string',
                    to: a,
                    access: createPropertyAccess(factory, 'request', 'params', a.name)
                }
            } else {
                queryVars.push(a)
                map[i] = {
                    from: 'string[]',
                    to: a,
                    access: createPropertyAccess(factory, 'request', 'query', a.name)
                }
            }
        } else
            map[i] = map[i] = {
                from: 'string',
                to: a,
                access: factory.createToken(ts.SyntaxKind.UndefinedKeyword) as any
            }
    })
    return factory.updateCallExpression(node, node.expression, undefined, [node.arguments[0],
        infer(factory, async (request) => {
            const ajv = new (require('ajv'))({coerceTypes: true})
            const schema = {
                type: "object",
                properties: {
                    query: {
                        type: "object",
                        properties: exfer(toExpression(factory, queryVars.reduce((obj, value) => {
                            obj[value.name] = {
                                type: value.primitive
                            }
                            return obj
                        }, {
                            query: {
                                type: "string"
                            }
                        }))),
                        required: exfer(toExpression(factory, queryVars.filter(a => !a.optional).map(a => toExpression(factory, a.name)))),
                        additionalProperties: false
                    },
                    params: {
                        type: "object",
                        properties: exfer(toExpression(factory, paramVars.reduce((obj, value) => {
                            obj[value.name] = {
                                type: value.primitive
                            }
                            return obj
                        }, {}))),
                        required: exfer(toExpression(factory, paramVars.filter(a => !a.optional).map(a => toExpression(factory, a.name)))),
                        additionalProperties: false
                    },

                },
                required: ["query", "params"],
                additionalProperties: true
            }
            const validate = ajv.compile(schema)

            if (!validate(request)) {
                throw new Error(validate.errors.map(a => a.message).join(','))
            }
            const response = await (exfer(node.arguments[1]))(...exfer(factory.createArrayLiteralExpression(map.map(a => a.access))))
            if (request.query.query)
                return require("jsonata")(request.query.query).evaluate(response)
            return response
        })
    ]);
});
