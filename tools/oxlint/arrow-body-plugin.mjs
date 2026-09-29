const EXPLICIT_RETURN_RULE_NAME = 'explicit-return-for-wrapped-arrow';
const DEFAULT_MAX_LEN = 80;

const getLineText = (sourceCode, lineNumber) => {
    const lines = sourceCode.lines ?? sourceCode.text.split(/\r?\n/u);

    return lines[lineNumber - 1] ?? '';
};

const buildRule = () => {
    return {
        meta: {
            type: 'layout',
            docs: {
                description:
                    'Require explicit-return arrow blocks when an implicit body wraps or exceeds the configured line length.'
            },
            schema: [
                {
                    type: 'object',
                    properties: {
                        maxLen: {
                            type: 'integer',
                            minimum: 1
                        }
                    },
                    additionalProperties: false
                }
            ],
            fixable: 'code',
            messages: {
                wrappedArrow:
                    'Use a block body with an explicit return when the implicit arrow body spans multiple lines or exceeds the configured line length.'
            }
        },
        create(context) {
            const option = context.options[0] ?? {};
            const maxLen = Number.isInteger(option.maxLen)
                ? option.maxLen
                : DEFAULT_MAX_LEN;
            const sourceCode = context.sourceCode;

            return {
                ArrowFunctionExpression(node) {
                    if (node.body.type === 'BlockStatement') {
                        return;
                    }

                    const bodyText = sourceCode.getText(node.body);
                    const bodySpansMultipleLines =
                        node.body.loc.start.line !== node.body.loc.end.line;
                    const bodyStartsOnDifferentLine =
                        node.loc.start.line !== node.body.loc.start.line;
                    const lineText = getLineText(
                        sourceCode,
                        node.loc.start.line
                    );
                    const lineExceedsMaxLen =
                        node.loc.start.line === node.loc.end.line &&
                        lineText.length > maxLen;

                    if (
                        !bodySpansMultipleLines &&
                        !bodyStartsOnDifferentLine &&
                        !lineExceedsMaxLen
                    ) {
                        return;
                    }

                    context.report({
                        node: node.body,
                        messageId: 'wrappedArrow',
                        fix(fixer) {
                            return fixer.replaceText(
                                node.body,
                                `{ return ${bodyText}; }`
                            );
                        }
                    });
                }
            };
        }
    };
};

const plugin = {
    meta: {
        name: 'arrow-body'
    },
    rules: {
        [EXPLICIT_RETURN_RULE_NAME]: buildRule()
    }
};

export default plugin;
