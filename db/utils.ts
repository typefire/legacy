import {exfer, infer, ofType, SourceTransformerContext} from "@typefire/transform/core";
import {DbContext, DbSet, Default, Entity, IQueryable, Lazy, WritableDbContext} from "../index";
import {toLiteral} from "@typefire/transform/helpers/resolve";
import {createHoistedVar, getImportFor} from "@typefire/transform/utils";
import {
    createObjectLiteral,
    createPropertyAccess,
    createUntypedArrow, createVoid0,
    toExpression
} from "@typefire/transform/helpers/create";
import * as ts from 'typescript'
import {getResolvedSymbol, getSymbol, getTypeDeclaration, getTypePath} from "@typefire/transform/helpers/types";

type QueryChainAction = {
    type: string;
    types?: ts.TypeNode[];
    arguments: ts.Expression[];
};
type QueryChain = [
    {
        type: "source";
        source: string;
        writable: boolean;
        isReference?: boolean
        reference?: ts.FunctionLikeDeclaration
    },
    ...QueryChainAction[]
];

function until(node: ts.Node, test: (node: ts.Node) => boolean, navigate: (node: ts.Node) => ts.Node) {
    let current = node
    while (current && !test(current))
        current = navigate(current)
    return current;
}

export function resolveQueryChain(
    context: SourceTransformerContext,
    node: ts.Node
): QueryChain {
    if (ts.isCallExpression(node)) {
        const left = node.expression;
        if (ts.isPropertyAccessExpression(left)) {
            return resolveQueryChain(context, left.expression).concat([
                {
                    type: left.name.text,
                    types: node.typeArguments?.filter((a) => a),
                    arguments: node.arguments.filter((a) => a),
                },
            ]) as QueryChain;
        } else if (ts.isIdentifier(left)) {
            return [] as any
        } else {
            console.log("resolve - left", node.kind, left.kind);
        }
    } else if (ts.isMemberName(node)) {
        const isReference = ofType<IQueryable<any>>(context, node)
        if (
            ofType<DbContext>(context, node) ||
            ofType<DbSet<any>>(context, node) ||
            ofType<WritableDbContext>(context, node) ||
            isReference
        ) {
            return [
                {
                    type: "source",
                    writable: ofType<WritableDbContext>(context, node),
                    source: node.text,
                    isReference: isReference,
                    reference: isReference ? (until(node, node => ts.isFunctionLike(node), node => node.parent) as ts.FunctionLikeDeclaration) : undefined
                },
            ];
        }
        throw new Error(
            `Only complete query chains are supported '${node.getText()}' in '${
                node.getSourceFile().fileName
            }'`
        );
    } else if (ts.isPropertyAccessExpression(node)) {
        if (
            ofType<DbSet<any>>(context, node)
        ) {
            const checker = context.context.checker
            return [
                {
                    type: "source",
                    writable: ofType<WritableDbContext>(context, node),
                    source: node.name.text,
                },
                {
                    type: 'get',
                    types: [checker.getTypeArguments(checker.getTypeAtLocation(node) as any)[0] as any],
                    arguments: []
                }
            ];
        }
        if (ofType<Entity>(context, node.expression)) {
            console.log('entity',node.name.getText(),getTypePath(context,node.expression))
        }
        console.log(node.name.getText(), getTypePath(context,node.expression),node.expression.getText())
    }
    console.log("resolve - node", node.kind);
    throw new Error(`Unsupported node in query ${node.getText()} (${node.kind})`);
}

export interface FieldConfig {
    unsigned?: boolean;
    precision?: number;
    scale?: number;
    specialType?: string;
    length?: number;
    default?: string | number | boolean | null;
    primaryKey?: number;
    onUpdate?: string | number | boolean | null;
    name: string;
    optional: boolean;
    type: string;
    tags: string[]
}

function resolveToBaseType(checker: ts.TypeChecker, type: ts.Type) {
    const apparentType = checker.getApparentType(
        type
    );
    if (ts.TypeFlags.Intersection & apparentType.flags) {
        return (apparentType as any).types.map(type => resolveToBaseType(checker, type)).find(a => a)
    }
    return apparentType.symbol?.valueDeclaration?.getSourceFile().fileName?.includes('lib.es') ? apparentType : undefined
}

type MatchFunc = (node: ts.Node, params: ts.TypeNode[], context: SourceTransformerContext) => boolean | ts.Node

// declare function matchType<T>(
//     callback: MatchFunc
// ): MatchFunc
//
// declare function walkType(
//     node: ts.Node,
//     ...matches: MatchFunc[]
// ): any

function getFieldConfig(
    context: SourceTransformerContext,
    value: ts.PropertyDeclaration
): FieldConfig {
    let optional = !!value.questionToken;
    const checker = context.context.checker;
    const type = resolveToBaseType(checker, checker.getTypeFromTypeNode(value.type!))
    const config: FieldConfig = {
        name: value.name.getText(),
        optional,
        type: type?.symbol?.name,
        tags: []
    };
    const visit = (node: ts.Node) => {
        if (ts.isLiteralTypeNode(node)) return toLiteral(node.literal);
        if (ts.isTypeReferenceNode(node)) {
            config.tags.push(...context.context.tags.getTagTypes(node))
            const name = getName(context, node.typeName);
            if (!name) {
                return;
            }
            if (node.typeArguments) {
                const args = node.typeArguments.map(visit);
                switch (name) {
                    case "OnUpdate":
                        config.onUpdate = args[1];
                        break;
                    case "PrimaryKey":
                        config.primaryKey = Number(args[1] ?? 0);
                        break;
                    case "Default":
                        config.default = args[1];
                        break;
                    case "Length":
                        config.length = Number(args[1] ?? 0);
                        break;
                    case 'Double':
                        config.precision = Number(args[0] ?? 0)
                        config.scale = Number(args[1] ?? 0)
                        config.specialType = 'double'

                        break
                    case 'Float':
                        config.length = Number(args[0] ?? 0)
                        config.specialType = 'float'
                        break
                    case 'Unsigned':
                        config.unsigned = true
                        break
                }
            } else {
                switch (name) {
                    case "Uuid":
                        config.specialType = name;
                        break;
                    case 'Integer':
                        config.specialType = 'int'
                        break
                }
            }
            return name;
        }
    };
    if (value.type) visit(value.type);
    return config;
}

interface ForeignKeyConfig {
    name: string,
    type: 'single' | 'many',
    otherType: string
}

interface EntityConfig {
    schemaName: string | null;
    tableName: string;
    fields: Record<string, FieldConfig>;
    primaryKey: string[];
    foreignKeys: ForeignKeyConfig[]
}

function getName(context: SourceTransformerContext, name: ts.PropertyName | ts.EntityName) {
    if (ts.isIdentifier(name)) return name.text
    if (ts.isStringLiteral(name)) return name.text
    if (ts.isNumericLiteral(name)) return name.text
    if (ts.isComputedPropertyName(name)) throw new Error(`Need to support computed properties`)
    if (ts.isQualifiedName(name)) return getName(context, name.left) + '.' + name.right.text
    return "";
}

export function getEntity(
    context: SourceTransformerContext,
    typeNode: ts.TypeNode | ts.Type
): EntityConfig {
    const checker = context.context.checker

    const symbol = (ts.isTypeNode(typeNode as any) ? checker.getTypeFromTypeNode(typeNode as ts.TypeNode) : typeNode as ts.Type)?.symbol;
    const name = symbol?.name;
    const declaration = symbol?.declarations![0] as ts.InterfaceDeclaration;
    let tableName: string | undefined;
    let schemaName: string | null = null;
    if (declaration?.heritageClauses)
        o: for (let heritageClause of declaration.heritageClauses!) {
            for (let type of heritageClause.types) {
                if (ofType<Entity>(context, type.expression)) {
                    const [schema, table] = type.typeArguments?.map((a) =>
                        ts.isLiteralTypeNode(a) ? (toLiteral(a.literal) as string) : null
                    ) ?? [];
                    schemaName = schema ?? 'default';
                    tableName = table ?? name;
                    break o;
                }
            }
        }
    if (!tableName) throw new Error(`Unknown entity ${name}`);
    // console.log("entity", tableName, schemaName);
    const foreignKeys: ForeignKeyConfig[] = []
    const fields: Record<string, FieldConfig> = {};
    for (let [name, value] of symbol.members?.entries() as any) {
        //questionToken
        const node = value.valueDeclaration
        if (ofType<Lazy<any>>(context, node)) {
            if (ts.isPropertySignature(node)) {
                const type: ts.TypeNode = (node.type as ts.NodeWithTypeArguments).typeArguments?.[0]
                const otherType = ts.isArrayTypeNode(type) ? type.elementType : type
                if (!ofType<Entity>(context, otherType))
                    throw new Error(`Foreign entities must be of Entity type.`)
                foreignKeys.push({
                    name: getName(context, node.name),
                    type: ts.isArrayTypeNode(type) ? 'many' : 'single',
                    otherType: getTypePath(context, otherType)
                })
            }
        } else {
            fields[name] = getFieldConfig(context, node);
        }
        // if (ts.isPropertyDeclaration(value.valueDeclaration)) {
        // }
    }
    // console.log(fields);
    const primaryKey = Object.keys(fields)
        .map((field) => fields[field])
        .filter((a) => a.primaryKey !== undefined)
        .sort((a, b) => a.primaryKey! - b.primaryKey!)
        .map((a) => a.name);
    if (!primaryKey.length && fields.id)
        primaryKey.push('id')
    return {
        schemaName,
        tableName,
        fields,
        primaryKey,
        foreignKeys
    };
}

interface WhereContext {
    paramName?: string;
    mapName: (name: string) => string;
    addParam: (value: ts.Expression | any) => string;
}

function generateStatement(node: ts.Node, context: WhereContext): string {
    switch (node.kind) {
        case ts.SyntaxKind.PropertyAccessExpression: {
            let access = node as ts.PropertyAccessExpression;
            return context.mapName(access.name.text);
        }
        case ts.SyntaxKind.Identifier: {
            let name = node.getText();
            if (name == context.paramName) {
                return "${}";
            }
            return context.addParam(node);
        }
        case ts.SyntaxKind.LiteralType:
            return context.addParam((node as ts.LiteralTypeNode).literal);
        case ts.SyntaxKind.StringLiteral:
            return context.addParam(node as ts.Expression);
        case ts.SyntaxKind.ParenthesizedExpression:
            return `(${generateNestedWhere(
                (node as ts.ParenthesizedExpression).expression,
                context
            )})`;
        case ts.SyntaxKind.BinaryExpression:
            return generateNestedWhere(node, context);
        default:
            throw new Error(`Unsupported statement ${node.kind} '${node.getText()}'`);
    }
}

export function generateComparison(
    left: string,
    operatorToken: ts.BinaryOperatorToken,
    right: string
) {
    switch (operatorToken.kind) {
        case ts.SyntaxKind.AmpersandAmpersandToken:
            return `${left} and ${right}`;
        case ts.SyntaxKind.BarBarToken:
            return `${left} or ${right}`;
        case ts.SyntaxKind.EqualsEqualsToken:
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
            return `${left}=${right}`;
        case ts.SyntaxKind.GreaterThanEqualsToken:
            return `${left}>=${right}`;
        case ts.SyntaxKind.GreaterThanToken:
            return `${left}>${right}`;
        case ts.SyntaxKind.LessThanToken:
            return `${left}<${right}`;
        case ts.SyntaxKind.LessThanEqualsToken:
            return `${left}<=${right}`;
        default:
            throw new Error(`Unknown operator ${operatorToken.getText()}`);
    }
}

export function generateNestedWhere(node: ts.Node, context: WhereContext): string {
    switch (node.kind) {
        case ts.SyntaxKind.Block:
            throw new Error("block statements aren't supported");
        case ts.SyntaxKind.BinaryExpression:
            let binary = node as ts.BinaryExpression;
            return generateComparison(
                generateStatement(binary.left, context),
                binary.operatorToken,
                generateStatement(binary.right, context)
            );
        case ts.SyntaxKind.CallExpression:
            return ''
        default:
            throw new Error(`Unsupported expression of kind '${node.kind} for ${node.getText()}'`);
    }
}

export function generateWhereQuery(
    factory: ts.NodeFactory,
    node: ts.Node,
    context: WhereContext
): string {
    if (ts.isArrowFunction(node)) {
        context.paramName = node.parameters[0].getText();
        return generateNestedWhere(node.body, context);
        // return factory.createArrayLiteralExpression([factory.createStringLiteral(where), ...keys.map(key => context.params[key])])
    }
    throw new Error("Only arrow functions are supported");
}

export function toPath(context: SourceTransformerContext,
                       node: ts.Node): string[] {
    if (ts.isPropertyAccessExpression(node))
        return toPath(context, node.expression).concat([node.name.text]);
    if (ts.isIdentifier(node)) return [node.text];
    if (ts.isCallExpression(node)) {
        const queryChain = resolveQueryChain(context, node)
        console.log(queryChain)
    }
    throw new Error(`Unsupported node ${node.getText()} (${node.kind})`);
}

export function resolveToParameter(
    param: ts.BindingName,
    name: string,
    currentPath = ["$"]
): string[] | undefined {
    if (ts.isIdentifier(param))
        return param.text === name ? currentPath : undefined;
    if (ts.isObjectBindingPattern(param)) {
        for (let element of param.elements) {
            let path = resolveToParameter(
                element.name,
                name,
                currentPath.concat([
                    ((element.propertyName ?? element.name) as ts.Identifier).text,
                ])
            );
            if (path) {
                return path;
            }
        }
    }
}

export function generateSelectMapping(
    context: SourceTransformerContext,
    node: ts.Node
) {
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
        const name = node.parameters[0];
        let body = node.body;
        while (ts.isParenthesizedExpression(body)) body = body.expression;
        if (ts.isPropertyAccessExpression(body)) {
            let path = toPath(context, body);
            path = resolveToParameter(name.name, path[0])!.concat(path.slice(1));
            return [[path]];
        } else if (ts.isIdentifier(body)) {
            let path = resolveToParameter(name.name, body.text);
            return [[path]];
        } else if (ts.isObjectLiteralExpression(body)) {
            let mapping = [];
            for (let property of body.properties) {
                if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
                    let path = ts.isPropertyAssignment(property) ? toPath(context, property.initializer) : toPath(context, property.name);
                    path = resolveToParameter(name.name, path[0])!.concat(path.slice(1));
                    mapping.push([path, [(property.name as ts.Identifier).text]]);
                } else {
                    throw new Error(`Unsupported assigment`)
                }
            }
            return mapping;
        }
    }
    throw new Error("Only single-line arrow functions are supported");
}

export function escapeMySqlColumn(name: string) {
    return "`" + name + "`";
}

export function paramToValue(context: SourceTransformerContext, param: any) {
    switch (typeof param) {
        case "undefined":
            return {
                isNull: true,
            };
        case "object":
            if (param === null)
                return {
                    isNull: true,
                };
            if (ts.isIdentifier(param) || ts.isPropertyAccessExpression(param)) {
                const type = context.context.checker.getTypeAtLocation(param);
                return {
                    stringValue: param,
                };
            }
            break;
        case "boolean":
            return {
                booleanValue: param,
            };
        case "number":
            return {
                doubleValue: param,
            };
        case "string":
            return {
                stringValue: param,
            };
        case "bigint":
            return {
                stringValue: String(param),
            };
    }
}

export function addWhere(context: SourceTransformerContext, querySpec: any, argument: any) {
    const whereContext: WhereContext = {
        addParam: (value) => {
            const name = `:${querySpec.paramNum++}`;
            if (value?.kind) {
                if (ts.isLiteralExpression(value)) {
                    value = value.text;
                }
            }
            querySpec.params[name] = value;
            return name;
        },
        mapName: (name) =>
            querySpec.from.name + "." + escapeMySqlColumn(name),
    };
    (querySpec.where ?? (querySpec.where = [])).push(generateWhereQuery(
        context.context.factory,
        argument,
        whereContext
    ));
}

export function generateSqlForQueryChain(
    context: SourceTransformerContext,
    chain: QueryChain
) {
    const [source, coreAction, ...actions] = chain;
    if (source.isReference)
        return createVoid0(context.context.factory)
    if (coreAction.type !== "get") throw new Error(`Get Required`);
    const entity = getEntity(context, coreAction.types![0]);
    const factory = context.context.factory;

    // console.log("entity", entity);

    const querySpec: any = {
        tableNum: 1,
        paramNum: 0,
        select: Object.keys(entity.fields),
        from: {
            name: "t0",
            schema: entity.schemaName,
            table: entity.tableName,
        },
        joins: [],
        where: undefined,
        limit: undefined,
        offset: undefined,
        params: {},
        mapping: undefined,
        single: undefined,
    };
    actions.forEach((action) => {
        switch (action.type as string) {
            case "take":
                querySpec.limit = Number(action.arguments[0].getText());
                break;
            case "slice":
                const end = Number(action.arguments[1].getText())
                querySpec.offset = Number(action.arguments[0].getText());
                if (!isNaN(end)) querySpec.limit = end - querySpec.offset;

                break;
            case "filter":
                addWhere(context, querySpec, action.arguments[0])
                break;
            case "map":
                const mapping = generateSelectMapping(context, action.arguments[0]);
                const columns = Array.from(new Set(mapping.map((a) => a[0]![1])));
                querySpec.select = columns;
                querySpec.mapping = mapping;
                break;
            case "toArray":
                if (action.arguments[0]) addWhere(context, querySpec, action.arguments[0])
                break;
            case "find":
                if (action.arguments[0]) addWhere(context, querySpec, action.arguments[0])
                querySpec.single = true;
                break
            case "findLast":
                if (action.arguments[0]) addWhere(context, querySpec, action.arguments[0])
                querySpec.single = true;
                break;
            case 'pipe':
                const declaration = getTypeDeclaration(context, action.arguments[0])
                console.log(declaration)
                process.exit(0)
                break
            case "update":
            case 'insert': {
                const value = action.arguments[0]
                const type = getResolvedSymbol(context, value)

                querySpec.update = {
                    source: value,
                    insert: action.type === 'insert',
                    fields: {}
                }
                if (type?.members) {
                    type.members.forEach((value, key) => {
                        if (!entity.fields[value.name]) {
                            if (entity.foreignKeys.some(fk => fk.name === value.name))
                                return
                            throw new Error(`Unknown field '${value.name}'`)
                        }
                        const name = `:${querySpec.paramNum++}`;
                        querySpec.params[name] = createPropertyAccess(factory, 'update', value.name);
                        querySpec.update.fields[value.name] = name
                    })
                }
            }
                break
            default:
                throw new Error(`Unsupported query option ${action.type}`);
        }
    });
    let query = `select ${querySpec.select.map(escapeMySqlColumn).join(", ")}
                 from ${escapeMySqlColumn(querySpec.from.table)} ${
                         querySpec.from.name
                 }
    `;
    if (querySpec.update) {
        if (querySpec.update.insert)
            query = `insert ${escapeMySqlColumn(querySpec.from.table)} (${Object.keys(querySpec.update.fields).map(escapeMySqlColumn).join(',')}) VALUES (${Object.keys(querySpec.update.fields).map(field => querySpec.update.fields[field]).join(',')})`
        else
            query = `update ${escapeMySqlColumn(querySpec.from.table)}
                     set ${Object.keys(querySpec.update.fields).map(field => `${escapeMySqlColumn(field)} = ${querySpec.update.fields[field]}`).join(', ')}`
    }
    if (querySpec.where) query += 'where ' + querySpec.where.map(w => `(${w})`).join(' AND ')
    if (querySpec.limit) query += ` limit ${querySpec.limit}`;
    if (querySpec.offset) query += ` offset ${querySpec.offset}`;
    // console.log(query, querySpec.params);
    const params = Object.keys(querySpec.params).map((name) => ({
        name: name.substring(1),
        value: paramToValue(context, querySpec.params[name]),
    }))
    return toExpression(factory, {
        params,
        query
    })
    const service = getImportFor(context, "aws-sdk", "RDSDataService");
    const resource = context.config.resources.rmdbs?.[entity.schemaName!];
    const serviceKey = JSON.stringify(service)
    const serviceName = createHoistedVar(context, 'rdsService', infer(factory, new (exfer(service))(exfer(resource.config))), serviceKey)
    const executeStatement = createHoistedVar(context, 'rdsExecuteStatement', infer(factory, (sql: string, params: any[]) => exfer(serviceName).executeStatement(exfer({
        database: entity.schemaName,
        sql: factory.createIdentifier('sql'),
        parameters: factory.createIdentifier('params'),
        resourceArn: resource.resourceArn,
        secretArn: resource.secretArn,
    })).promise()), serviceKey + '.executeStatement')

    const call = infer(factory, exfer(executeStatement)(exfer(query), exfer(params)))

    // const call = factory.createCallExpression(
    //     factory.createPropertyAccessExpression(
    //         factory.createCallExpression(
    //             factory.createPropertyAccessExpression(
    //                 factory.createNewExpression(
    //                     service,
    //                     [],
    //                     [createObjectLiteral(factory, resource.config)]
    //                 ),
    //                 "executeStatement"
    //             ),
    //             [],
    //             [
    //                 createObjectLiteral(factory, {
    //                     database: entity.schemaName,
    //                     sql: query,
    //                     parameters: Object.keys(querySpec.params).map((name) => ({
    //                         name: name.substring(1),
    //                         value: paramToValue(context, querySpec.params[name]),
    //                     })),
    //                     resourceArn: resource.resourceArn,
    //                     secretArn: resource.secretArn,
    //                 }),
    //             ]
    //         ),
    //         "promise"
    //     ),
    //     [],
    //     []
    // );
    //[ [ [ '$', 'id' ], [ 'a' ] ], [ [ '$', 'name' ], [ 'n' ] ] ]
    console.log(querySpec.mapping)
    const mappingObj =
        querySpec.mapping && querySpec.mapping[0][1]
            ? querySpec.mapping.reduce(
                (
                    o: Record<string, ts.Expression>,
                    [access, propPath]: [string[], string[]]
                ) => {
                    o[propPath[0]] = createPropertyAccess(factory, ...access);
                    return o;
                },
                {}
            )
            : undefined;

    const defaultMap = infer(factory, exfer(factory.createIdentifier('$')).records.map(a => exfer(querySpec.select).reduce((o, c, i) => {
        o[c] = a[i][(Object.keys)(a[i])[0]];
        return o;
    }, {})))
    // const defaultMap = factory.createCallExpression(
    //     createPropertyAccess(factory, "$", "records", "map"),
    //     [],
    //     [
    //         createUntypedArrow(
    //             factory,
    //             factory.createCallExpression(
    //                 factory.createPropertyAccessExpression(
    //                     toExpression(factory, querySpec.select),
    //                     "reduce"
    //                 ),
    //                 [],
    //                 [
    //                     createUntypedArrow(
    //                         factory,
    //                         factory.createBlock([
    //                             factory.createExpressionStatement(
    //                                 factory.createAssignment(
    //                                     factory.createElementAccessExpression(
    //                                         factory.createIdentifier("o"),
    //                                         factory.createIdentifier("c")
    //                                     ),
    //                                     factory.createElementAccessExpression(
    //                                         factory.createElementAccessExpression(
    //                                             factory.createIdentifier("a"),
    //                                             factory.createIdentifier("i")
    //                                         ),
    //                                         factory.createElementAccessExpression(
    //                                             factory.createCallExpression(
    //                                                 createPropertyAccess(factory, "Object", "keys"),
    //                                                 [],
    //                                                 [
    //                                                     factory.createElementAccessExpression(
    //                                                         factory.createIdentifier("a"),
    //                                                         factory.createIdentifier("i")
    //                                                     ),
    //                                                 ]
    //                                             ),
    //                                             0
    //                                         )
    //                                     )
    //                                 )
    //                             ),
    //                             factory.createReturnStatement(factory.createIdentifier("o")),
    //                         ]),
    //                         "o",
    //                         "c",
    //                         "i"
    //                     ),
    //                     createObjectLiteral(factory, {}),
    //                 ]
    //             ),
    //             "a"
    //         ),
    //     ]
    // );
    const result = querySpec.mapping
        ? infer(factory, exfer(defaultMap).map($ => exfer(mappingObj
            ? toExpression(factory, mappingObj)
            : createPropertyAccess(factory, ...querySpec.mapping[0][0]))))
        // ? factory.createCallExpression(
        //     factory.createPropertyAccessExpression(defaultMap, "map"),
        //     [],
        //     [
        //         createUntypedArrow(
        //             factory,
        //             mappingObj
        //                 ? factory.createParenthesizedExpression(
        //                     createObjectLiteral(factory, mappingObj)
        //                 )
        //                 : createPropertyAccess(factory, ...querySpec.mapping[0][0]),
        //             "$"
        //         ),
        //     ]
        // )
        : defaultMap;
    const statement = infer(factory, exfer(call).then($ => exfer(querySpec.single
        ? factory.createElementAccessExpression(result, 0)
        : result)))
    return querySpec.update ? infer(factory, ((update: any) => exfer(statement))(exfer(querySpec.update.source))) : statement
    // return factory.createCallExpression(
    //     factory.createPropertyAccessExpression(call, "then"),
    //     [],
    //     [
    //         createUntypedArrow(
    //             factory,
    //             querySpec.single
    //                 ? factory.createElementAccessExpression(result, 0)
    //                 : result,
    //             "$"
    //         ),
    //     ]
    // );
    // columns.reduce((o,c,i)=>{
    //   o[c] = e[i][Object.keys(e[i])[0]]
    //   return o
    // },{})
}
