import {IQueryable,} from "./index";
import {ofType, SourceTransformerContext, withCall} from "@typefire/transform";
import * as ts from "typescript";
import {SyntaxKind} from "typescript";
import * as process from "process";
import {generateSqlForQueryChain, resolveQueryChain} from "./transform/utils";

register<ts.CallExpression>([ts.SyntaxKind.CallExpression], (node, context) => {
    const {context: {checker}} = context
    if (node.arguments?.some(a => ofType<IQueryable<any>>(context, a))) {
        console.log(node.getText())
        process.exit(0)
    }
    return node
})

type QueryChain = any[]

function extend<R>(obj: any, key: string, initializer: () => R): R {
    return obj[key] ?? (obj[key] = initializer())
}

function getQueryableFunctions(context: SourceTransformerContext) {
    return extend(context, 'queryable:functions', () => new Map<ts.FunctionDeclaration, QueryChain>())
}


interface Block {
    used: Set<string>
    inputs: Record<string, ts.Node>
    locals: Record<string, ts.Node>
    mutates: Record<string, {
        condition: ts.Node,
        expression: ts.Node
    }>
    returns: {
        condition?: ts.Node,
        expression: ts.Node
    }[]
    parent: Block
    children: Block[],
    condition: ts.Node
}

type Chain = any[] & { locals: Record<string, any> }

function createBlock(parent?: Block, condition?: ts.Node): Block {
    const block: Block = {
        parent,
        inputs: {},
        locals: {},
        mutates: {},
        returns: [],
        children: [],
        used: new Set(),
        condition
    }
    if (parent)
        parent.children.push(block)
    return block
}

function populateLocals(chain: Block, prop: 'inputs' | 'locals', binding: ts.BindingName, dec: ts.Node, path: (string | number)[] = []) {
    switch (binding.kind) {
        case ts.SyntaxKind.ObjectBindingPattern:
            binding.elements.forEach(el => {
                populateLocals(chain, prop, el.name, dec, path.concat([el.propertyName as any]))
            })
            break;
        case ts.SyntaxKind.Identifier:
            chain[prop][binding.text] = dec
            break;
        case ts.SyntaxKind.ArrayBindingPattern:
            binding.elements.forEach((a, i) => {
                if (ts.isBindingElement(a))
                    populateLocals(chain, prop, a.name, dec, path.concat([i]))
            })
            break;

    }
}

function walkExpression(context: SourceTransformerContext, chain: Block, node: ts.Expression) {
    if (ts.isCallExpression(node)) {
        walkExpression(context, chain, node.expression)
        node.arguments.map((arg) => walkExpression(context, chain, arg))
        return node
    }
    if (ts.isPropertyAccessExpression(node)) {
        walkExpression(context, chain, node.expression)
        return node
    }
    if (ts.isIdentifier(node)) {
        chain.used.add(node.text)
        return node
    }
    if (ts.isBinaryExpression(node)) {
        switch (node.operatorToken.kind) {
            case ts.SyntaxKind.QuestionQuestionToken:
                break;
            case ts.SyntaxKind.AsteriskAsteriskToken:
                break;
            case ts.SyntaxKind.AsteriskToken:
                break;
            case ts.SyntaxKind.SlashToken:
                break;
            case ts.SyntaxKind.PercentToken:
                break;
            case ts.SyntaxKind.PlusToken:
                break;
            case ts.SyntaxKind.MinusToken:
                break;
            case ts.SyntaxKind.LessThanLessThanToken:
                break;
            case ts.SyntaxKind.GreaterThanGreaterThanToken:
                break;
            case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
                break;
            case ts.SyntaxKind.LessThanToken:
                break;
            case ts.SyntaxKind.LessThanEqualsToken:
                break;
            case ts.SyntaxKind.GreaterThanToken:
                break;
            case ts.SyntaxKind.GreaterThanEqualsToken:
                break;
            case ts.SyntaxKind.InstanceOfKeyword:
                break;
            case ts.SyntaxKind.InKeyword:
                break;
            case ts.SyntaxKind.EqualsEqualsToken:
                break;
            case ts.SyntaxKind.EqualsEqualsEqualsToken:
                break;
            case ts.SyntaxKind.ExclamationEqualsEqualsToken:
                break;
            case ts.SyntaxKind.ExclamationEqualsToken:
                break;
            case ts.SyntaxKind.AmpersandToken:
                break;
            case ts.SyntaxKind.BarToken:
                break;
            case ts.SyntaxKind.CaretToken:
                break;
            case ts.SyntaxKind.AmpersandAmpersandToken:
                break;
            case ts.SyntaxKind.BarBarToken:
                break;
            case ts.SyntaxKind.EqualsToken:
                chain.mutates[(node.left as ts.Identifier).text] = {
                    condition: null,
                    expression: node.right
                }
                break;
            case ts.SyntaxKind.PlusEqualsToken:
                break;
            case ts.SyntaxKind.MinusEqualsToken:
                break;
            case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
                break;
            case ts.SyntaxKind.AsteriskEqualsToken:
                break;
            case ts.SyntaxKind.SlashEqualsToken:
                break;
            case ts.SyntaxKind.PercentEqualsToken:
                break;
            case ts.SyntaxKind.AmpersandEqualsToken:
                break;
            case ts.SyntaxKind.BarEqualsToken:
                break;
            case ts.SyntaxKind.CaretEqualsToken:
                break;
            case ts.SyntaxKind.LessThanLessThanEqualsToken:
                break;
            case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
                break;
            case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
                break;
            case ts.SyntaxKind.BarBarEqualsToken:
                break;
            case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
                break;
            case ts.SyntaxKind.QuestionQuestionEqualsToken:
                break;
            case ts.SyntaxKind.CommaToken:
                break;

        }
        walkExpression(context, chain, node.left)
        walkExpression(context, chain, node.right)
        return node
    }
    if (ts.isArrowFunction(node)) {
        walkFunction(context, node, chain)
        return node
    }
    if (ts.isLiteralExpression(node))
        return node

    if (node.kind === SyntaxKind.ThisKeyword) {
        return node
    }
    // throw new Error(`Can't walk expression of type ${node.kind} - '${node.getText()}'`)
}

function walkStatements(context: SourceTransformerContext, block: Block, statements: ArrayLike<ts.Statement>): Block {
    const chain = [] as Chain
    chain.locals = {}
    Array.from(statements).every(statement => {
        if (!statement)
            return true
        if (ts.isReturnStatement(statement)) {
            block.returns.push({
                expression: walkExpression(context, block, statement.expression)
            })
            return false
        } else if (ts.isVariableStatement(statement)) {
            chain.push({
                type: 'variables',
                declarations: statement.declarationList.declarations
            })
            statement.declarationList.declarations.forEach(dec => {
                populateLocals(block, 'locals', dec.name, dec)
            })
        } else if (ts.isIfStatement(statement)) {
            const thenBlock = walkStatements(context, createBlock(block, statement.expression), [statement.thenStatement])
            const elseBlock = statement.elseStatement ? walkStatements(context, createBlock(block), [statement.elseStatement]) : undefined

            if (thenBlock.returns.length)
                block.returns.push(...thenBlock.returns.map(a => ({condition: walkExpression(context, block, statement.expression), ...a})))
            if (elseBlock?.returns.length)
                block.returns.push(...elseBlock.returns)

        } else if (ts.isBlock(statement)) {
            const statementBlock = walkStatements(context, createBlock(block), statement.statements)
            if (statementBlock.returns.length)
                block.returns.push(...statementBlock.returns)
        } else if (ts.isExpressionStatement(statement)) {
            chain.push({
                type: 'expression',
                expression: walkExpression(context, block, statement.expression)
            })
        } else {
            throw new Error(`Unsupported statement for '${statement.kind}' (${statement.getText()})`)
        }
        return true
    })
    return block
}

function walkFunction(context: SourceTransformerContext, node: ts.FunctionDeclaration | ts.ArrowFunction, parent?: Block): Block {
    const block = createBlock(parent)
    node.parameters.forEach(param => {
        populateLocals(block, 'inputs', param.name, param, [])
    })
    if (ts.isBlock(node.body))
        walkStatements(context, block, node.body.statements)
    else
        walkExpression(context, block, node.body)
    if (!parent) {
        // console.log(block)
        // process.exit(0)
    }
    return block
}


register<ts.FunctionDeclaration>([ts.SyntaxKind.FunctionDeclaration], (node, context) => {
    const {context: {checker}} = context
    if (ofType<IQueryable<any>>(context, checker.getTypeAtLocation(node).getCallSignatures()[0]?.getReturnType())) {
        const query = walkFunction(context, node)
        // getQueryableFunctions(context).set(node, query)
        // console.log(node.getText())
        // process.exit(0)
    }
    return node
})
//
//
withCall<IQueryable<any>["toArray"]>((node, context) => {
    return generateSqlForQueryChain(context, resolveQueryChain(context, node));
});
//
// withCall<IQueryable<any>["find"]>((node, context) => {
//     return generateSqlForQueryChain(context, resolveQueryChain(context, node));
// });
//
// withCall<IQueryable<any>["findMap"]>((node, context) => {
//     return generateSqlForQueryChain(context, resolveQueryChain(context, node));
// });
//
// withCall<IQueryable<any>["findLast"]>((node, context) => {
//     return generateSqlForQueryChain(context, resolveQueryChain(context, node));
// });
//
// withCall<IQueryable<any>["count"]>((node, context) => {
//     return generateSqlForQueryChain(context, resolveQueryChain(context, node));
// });
//
// withCall<IQueryable<any>["every"]>((node, context) => {
//     return generateSqlForQueryChain(context, resolveQueryChain(context, node));
// });
//
// withCall<IQueryable<any>["some"]>((node, context) => {
//     return generateSqlForQueryChain(context, resolveQueryChain(context, node));
// });
//
// withCall<DbSet<any>["update"]>((node, context) => {
//     return generateSqlForQueryChain(context, resolveQueryChain(context, node));
// });
//
// withCall<DbSet<any>["remove"]>((node, context) => {
//     return generateSqlForQueryChain(context, resolveQueryChain(context, node));
// });
//
// withCall<DbSet<any>["insert"]>((node, context) => {
//     return generateSqlForQueryChain(context, resolveQueryChain(context, node));
// });
//
//
