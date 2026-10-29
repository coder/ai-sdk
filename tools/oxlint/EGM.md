# anti-slop oxlint plugin (`tools/oxlint`)

## Overview

`tools/oxlint` holds repo-local oxlint plugins. It has no source files of its own. Its only
child, `anti-slop/`, is the vendored [anti-slop](https://github.com/dmmulroy/anti-slop) oxlint
JS plugin. Its rules reject low-evidence TypeScript patterns, such as unjustified type
assertions and `unknown` in signatures. `anti-slop/index.ts` registers 15 rules from
`anti-slop/rules/`, which use helpers from `anti-slop/shared/`.

This one contract covers the whole plugin. It lives here, outside `anti-slop/`, because
CONTRIBUTING.md says that folder stays byte-identical to upstream
[../../CONTRIBUTING.md:The anti-slop lint rules]. So `anti-slop/` and its subfolders have no
EGM.md files.

- Oxlint loads the plugin from TypeScript source through `jsPlugins`
  [../../.oxlintrc.json:jsPlugins]. CONTRIBUTING.md says this needs Node ≥ 22.18
  [../../CONTRIBUTING.md:The anti-slop lint rules].
- `.oxlintrc.json` enables all 15 rules as `"error"`, under the `anti-slop/` prefix
  [../../.oxlintrc.json:rules].
- Updating: copy `skills/install-anti-slop/assets/anti-slop/` from upstream over
  `tools/oxlint/anti-slop/` and record the upstream commit in the PR. oxfmt and oxlint exclude
  `anti-slop/` so it stays byte-identical to upstream. Bump `oxlint` and `@oxlint/plugins` together
  [../../CONTRIBUTING.md:The anti-slop lint rules].
- Regenerate this file after an upstream update.
- Ratchet: the `overrides` section of `.oxlintrc.json` lists, per rule, legacy files with that
  rule switched off. Remove a file once it is clean, and never add new files
  [../../.oxlintrc.json:overrides] [../../CONTRIBUTING.md:The anti-slop lint rules].
  Rules with a ratchet list: `no-chained-type-assertions`,
  `no-conditional-empty-object-spread`, `no-known-value-widening`, `no-module-mocking`,
  `no-runtime-typeof`, `no-unknown-parameters`, `no-unsafe-dictionary-type` and
  `require-safety-comment-for-type-assertion`.
- For `**/test/**/*.ts` and `**/*.test.ts`, `.oxlintrc.json` turns off
  `no-chained-type-assertions`, `no-known-value-widening`, `no-unknown-parameters`,
  `no-unsafe-dictionary-type` and `require-safety-comment-for-type-assertion`
  [../../.oxlintrc.json:overrides].

## Interface

### Plugin entry (`anti-slop/index.ts`)

- `antiSlopPlugin` is the default export, built with `eslintCompatPlugin` and
  `meta: { name: "anti-slop" }`. Its `rules` map registers each rule by name: for example
  `"no-shape-in-symbol-names"` maps to `noForbiddenTermInSymbolNamesRule`, and every other
  name maps to its camel-case const with a `Rule` suffix. [anti-slop/index.ts:antiSlopPlugin]

### Rules (`anti-slop/rules/`)

`anti-slop/rules/` holds 15 rule modules. Each file exports one rule built with
`defineRule` from `@oxlint/plugins`. `anti-slop/index.ts` registers each rule under a name.
Every rule has one message, no fixer and no suggestions. Only `no-runtime-typeof` takes an
option. Helpers shared by several rules live in
`anti-slop/shared/` (see the next section).

Registered names come from the `rules` map in `anti-slop/index.ts`
[anti-slop/index.ts:antiSlopPlugin].

- `no-chained-type-assertions` (`noChainedTypeAssertionsRule`, type `"problem"`, messageId
  `chained`). It reports the outermost `TSAsExpression` or `TSTypeAssertion` of a nested chain
  (parentheses allowed) with two or more assertions, when at least one is not a const
  assertion. No options. [anti-slop/rules/no-chained-type-assertions.ts:noChainedTypeAssertionsRule]
- `no-conditional-empty-object-spread` (`noConditionalEmptyObjectSpreadRule`, type
  `"suggestion"`, messageId `avoid`). It reports a `SpreadElement` inside an
  `ObjectExpression` whose argument is a conditional with an empty object literal branch,
  for example `{ ...(c ? { x } : {}) }`. No options.
  [anti-slop/rules/no-conditional-empty-object-spread.ts:noConditionalEmptyObjectSpreadRule]
- `no-known-value-widening` (`noKnownValueWideningRule`, type `"problem"`, messageId
  `widening`). It reports a value with known evidence that flows into an explicit type that
  `classifyWideningTarget` classifies as a widening target. Checked flows: a variable
  initializer, a class property value, an `=` assignment to a declared variable, a `return`
  argument, an arrow expression body, and the operand of a type assertion. The message data
  `target` is the target kind. No options.
  [anti-slop/rules/no-known-value-widening.ts:noKnownValueWideningRule]
- `no-module-mocking` (`noModuleMockingRule`, type `"problem"`, messageId `moduleMock`). It
  reports calls of `mock`, `doMock` or `unstable_mockModule` on a `vi` or `jest` object, by
  dot or by string-literal bracket access. No options. [anti-slop/rules/no-module-mocking.ts:noModuleMockingRule]
- `no-object-parameters` (`noObjectParametersRule`, type `"problem"`, messageId
  `objectParameter`). It reports a parameter type annotation that resolves to the `object`
  keyword, directly, through parentheses, through any union member, or through a top-level
  non-generic type alias. It checks the parameters of functions, arrows, method signatures,
  call and construct signatures, and function and constructor types. No options.
  [anti-slop/rules/no-object-parameters.ts:noObjectParametersRule]
- `no-reflect-apply` (`noReflectApplyRule`, type `"problem"`, messageId `reflectApply`). It
  reports calls of `Reflect.apply` on the global `Reflect`. No options.
  [anti-slop/rules/no-reflect-apply.ts:noReflectApplyRule]
- `no-reflect-get` (`noReflectGetRule`, type `"problem"`, messageId `reflectGet`). It reports
  calls of `Reflect.get` on the global `Reflect`. No options. [anti-slop/rules/no-reflect-get.ts:noReflectGetRule]
- `no-runtime-typeof` (`noRuntimeTypeofRule`, type `"problem"`, messageId `runtimeTypeof`).
  It reports every `typeof` unary expression. Option schema:
  `{ allowInTypeGuards: boolean }` with `additionalProperties: false`. Default
  `[{ allowInTypeGuards: false }]`. With `allowInTypeGuards: true` it skips `typeof` whose
  nearest enclosing function has a type-predicate return type.
  [anti-slop/rules/no-runtime-typeof.ts:noRuntimeTypeofRule]
- `no-shape-in-symbol-names` (exported as `noForbiddenTermInSymbolNamesRule`, type
  `"problem"`, messageId `forbiddenSymbolName`). It reports every visited `Identifier`,
  `PrivateIdentifier` and `JSXIdentifier` whose name contains `"shape"`, case-insensitive. It
  does not check whether the identifier declares a symbol. No options.
  [anti-slop/rules/no-shape-in-symbol-names.ts:noForbiddenTermInSymbolNamesRule]
- `no-unknown-parameters` (`noUnknownParametersRule`, type `"problem"`, messageId
  `unknownParameter`). It reports a parameter whose annotation is exactly the `unknown`
  keyword. It checks the same parameter owners as `no-object-parameters`. No options.
  [anti-slop/rules/no-unknown-parameters.ts:noUnknownParametersRule]
- `no-unknown-returns` (`noUnknownReturnsRule`, type `"problem"`, messageId
  `unknownReturn`). It reports an explicit return type that resolves to `unknown`: directly,
  through parentheses, through any union member, through the first type argument of
  `Promise` or `PromiseLike`, or through a top-level non-generic alias. No options.
  [anti-slop/rules/no-unknown-returns.ts:noUnknownReturnsRule]
- `no-unknown-type-aliases` (`noUnknownTypeAliasesRule`, type `"problem"`, messageId
  `unknownAlias`). It reports the name of a top-level type alias whose body resolves to
  `unknown` directly, through parentheses, or through other top-level non-generic aliases.
  No options. [anti-slop/rules/no-unknown-type-aliases.ts:noUnknownTypeAliasesRule]
- `no-unsafe-dictionary-type` (`noUnsafeDictionaryTypeRule`, type `"problem"`, messageId
  `unsafeDictionary`). It reports a dictionary type (index signature, mapped type, `Record`,
  or an alias of one) whose value type is unsafe as judged by `classifyUnsafeDictionary` and
  `classifyUnsafeDictionaryValue`. The message data `value` is one of `"any"`,
  `"empty-object"`, `"object"`, `"union"` or `"unknown"`. No options.
  [anti-slop/rules/no-unsafe-dictionary-type.ts:noUnsafeDictionaryTypeRule]
- `no-widen-then-assert` (`noWidenThenAssertRule`, type `"problem"`, messageId
  `widenThenAssert`). It reports a later type assertion on a `const` binding that was declared
  with a broad type (`unknown`, `any`, `object`, or a broad record) over a known value, when
  the assertion is narrower and sits in the same function. No options.
  [anti-slop/rules/no-widen-then-assert.ts:noWidenThenAssertRule]
- `require-safety-comment-for-type-assertion` (`requireSafetyCommentForTypeAssertionRule`,
  type `"problem"`, messageId `missingSafetyComment`). It reports every non-const type
  assertion without a preceding comment that matches `/\bSAFETY\s*:/u`. No options.
  [anti-slop/rules/require-safety-comment-for-type-assertion.ts:requireSafetyCommentForTypeAssertionRule]

### Shared helpers (`anti-slop/shared/`)

`anti-slop/shared/` holds pure AST helpers that several rules share.
`dictionary-types.ts` builds a per-file type environment and classifies dictionary and
widening target types. `lexical-type-parameters.ts` collects type-parameter names in scope.
`reflect-method.ts` detects calls on the global `Reflect` object.

- `createTypeEnvironment(program): TypeEnvironment` scans top-level statements of `program`,
  unwrapping `export` declarations. It records the first type alias per name, every interface
  declaration per name, and the names that shadow a built-in (see Invariants).
  [anti-slop/shared/dictionary-types.ts:createTypeEnvironment]
- `TypeEnvironment` has readonly `aliases`, `interfaces` and `shadowedBuiltIns` collections.
  [anti-slop/shared/dictionary-types.ts:TypeEnvironment]
- `classifyUnsafeDictionary(type, environment): UnsafeDictionary | null` collects the value
  types of a dictionary type and returns the first unsafe one.
  [anti-slop/shared/dictionary-types.ts:classifyUnsafeDictionary]
- `classifyUnsafeDictionaryValue(valueType, environment): UnsafeDictionary | null` classifies
  one value type directly. [anti-slop/shared/dictionary-types.ts:classifyUnsafeDictionaryValue]
- `UnsafeDictionary` is `{ kind: "unsafe-dictionary"; unsafeValue }`, where `unsafeValue` is
  `"any"`, `"empty-object"`, `"object"`, `"union"` or `"unknown"`.
  [anti-slop/shared/dictionary-types.ts:UnsafeDictionary]
- `classifyWideningTarget(type, environment): WideningTarget | null` returns a target kind for
  an explicit type. After unwrapping parentheses and `readonly`: `unknown` gives `"unknown"`,
  `object` gives `"object"`, a type literal gives `"open dictionary"` with an index signature
  or `"anonymous object"` with other members, a mapped type or `Record` gives
  `"open dictionary"`, and `Readonly`, `Partial`, `Required` and `NonNullable` recurse into
  their first type argument. A generic local alias over a dictionary gives
  `"generic container"`. A non-generic local alias resolves through
  `classifyAliasBroadTarget` (see Invariants, Shared helpers), which can give `"unknown"`,
  `"object"` or `"open dictionary"`. Other types give `null`.
  [anti-slop/shared/dictionary-types.ts:classifyWideningTarget]
  [anti-slop/shared/dictionary-types.ts:classifyAliasBroadTarget]
- `WideningTarget` is `{ kind: WideningTargetKind }`. `WideningTargetKind` is
  `"anonymous object"`, `"generic container"`, `"object"`, `"open dictionary"` or
  `"unknown"`. [anti-slop/shared/dictionary-types.ts:WideningTarget] [anti-slop/shared/dictionary-types.ts:WideningTargetKind]
- `isKnownEvidenceExpression(expression): boolean` unwraps parentheses, `as`, `<T>`, `!` and
  `satisfies`, then accepts an object, array, arrow, class, function, `new`, literal, template
  literal or unary expression. [anti-slop/shared/dictionary-types.ts:isKnownEvidenceExpression]
- `isPopulatedObjectExpression(expression): boolean` unwraps parentheses, `as`, `<T>` and `!`
  (not `satisfies`), then accepts an object literal with at least one property. No file in
  this plugin imports it. [anti-slop/shared/dictionary-types.ts:isPopulatedObjectExpression]
- `lexicalTypeParameterNames(node, visitorKeys): ReadonlySet<string>` walks from `node` up to,
  not including, `Program`. It collects names from every `typeParameters` list, the key of a
  mapped type when reached from its `nameType` or `typeAnnotation`, and `infer` names of a
  conditional type when reached from its `trueType`.
  [anti-slop/shared/lexical-type-parameters.ts:lexicalTypeParameterNames]
- `isGlobalReflectMethodCall(sourceCode, callee, methodName): boolean` is true for a member
  call on the global `Reflect` whose property is the identifier `methodName`, or a computed
  string literal equal to `methodName`. [anti-slop/shared/reflect-method.ts:isGlobalReflectMethodCall]

## Invariants

### Plugin entry

- The 15 rule names registered in `antiSlopPlugin` match the 15 `anti-slop/<name>` keys in
  `.oxlintrc.json` `rules`. Keep both lists in step. [anti-slop/index.ts:antiSlopPlugin]
  [../../.oxlintrc.json:rules]
- oxlint does not lint `anti-slop/` [../../.oxlintrc.json:ignorePatterns]. oxfmt does not
  format it [../../.oxfmtrc.json:ignorePatterns].

### Rules

- Const assertions (`as const`, `<const>`) are a `TSTypeReference` named `const`. They do not
  count toward a chain and do not need a SAFETY comment.
  [anti-slop/rules/no-chained-type-assertions.ts:isConstAssertion]
  [anti-slop/rules/require-safety-comment-for-type-assertion.ts:isConstAssertion]
- A chain is reported once, at its outermost assertion, and only when it has more than one
  assertion and at least one non-const assertion.
  [anti-slop/rules/no-chained-type-assertions.ts:isOutermostAssertionInChain]
  [anti-slop/rules/no-chained-type-assertions.ts:isForbiddenAssertionChain]
- `no-conditional-empty-object-spread` unwraps only parentheses. It does not match `&&`
  spreads or array and call spreads. An empty branch is an `ObjectExpression` with zero
  properties. [anti-slop/rules/no-conditional-empty-object-spread.ts:isConditionalEmptyObjectSpread]
- `no-known-value-widening` treats a value as known when `isKnownEvidenceExpression` accepts
  it, or when it is an identifier for a never-reassigned `const` with a single declarator
  whose initializer is known. A visited set stops cycles.
  [anti-slop/rules/no-known-value-widening.ts:hasKnownEvidence] [anti-slop/rules/no-known-value-widening.ts:isStableConstVariable]
- `no-known-value-widening` skips an empty object literal that flows into an
  `"open dictionary"` or `"generic container"` target.
  [anti-slop/rules/no-known-value-widening.ts:isDictionaryAccumulatorTarget]
- `no-known-value-widening` checks only the outermost assertion of a directly nested
  assertion pair. [anti-slop/rules/no-known-value-widening.ts:hasParentAssertion]
- `no-module-mocking` accepts `vi` or `jest` when the name is a global reference or has no
  definition, and any local name imported as `vi` from `"vitest"` or as `jest` from
  `"@jest/globals"`. [anti-slop/rules/no-module-mocking.ts:isTestFrameworkObject]
  [anti-slop/rules/no-module-mocking.ts:moduleMockMethods]
- `no-object-parameters` and `no-unknown-returns` do not follow an alias whose name is
  shadowed by a type parameter in scope, as computed by `lexicalTypeParameterNames`.
  [anti-slop/rules/no-object-parameters.ts:noObjectParametersRule] [anti-slop/rules/no-unknown-returns.ts:noUnknownReturnsRule]
- `no-object-parameters`, `no-unknown-returns` and `no-unknown-type-aliases` collect aliases
  only from top-level statements and `export` declarations, and follow only references
  without type arguments to aliases without type parameters.
  [anti-slop/rules/no-object-parameters.ts:noObjectParametersRule] [anti-slop/rules/no-unknown-returns.ts:referencedAliasName]
  [anti-slop/rules/no-unknown-type-aliases.ts:referencedAliasName]
- `no-unknown-type-aliases` does not look inside unions or `Promise`, so
  `type A = string | unknown` is not reported. [anti-slop/rules/no-unknown-type-aliases.ts:noUnknownTypeAliasesRule]
- `no-unknown-parameters` skips a parameter named `cause`, also through default values, rest
  elements and parameter properties. It does not report `unknown` inside unions or aliases.
  [anti-slop/rules/no-unknown-parameters.ts:noUnknownParametersRule] [anti-slop/rules/no-unknown-parameters.ts:parameterName]
- `no-runtime-typeof` exempts only the nearest enclosing function. A plain function nested in a
  type guard is not exempt. [anti-slop/rules/no-runtime-typeof.ts:isInsideTypeGuard]
- `no-unsafe-dictionary-type` does not report a plain use of a local alias without type
  arguments outside a type alias declaration. It reports only the outermost unsafe type, using
  the node kinds in `typeNodeKinds` for ancestor checks.
  [anti-slop/rules/no-unsafe-dictionary-type.ts:isPlainAliasConsumerUse]
  [anti-slop/rules/no-unsafe-dictionary-type.ts:shouldReportType] [anti-slop/rules/no-unsafe-dictionary-type.ts:typeNodeKinds]
- `no-unsafe-dictionary-type` also checks each index signature outside a type literal (in an
  interface or class body) that has a type annotation. It classifies the value type with
  `classifyUnsafeDictionaryValue` and reports at the signature. So
  `interface X { [k: string]: unknown }` is reported.
  [anti-slop/rules/no-unsafe-dictionary-type.ts:noUnsafeDictionaryTypeRule]
- `no-widen-then-assert` needs a `const` declarator with an identifier, an initializer, and no
  write other than the initializer. The broad kind comes from the annotation or from an
  initializer assertion. [anti-slop/rules/no-widen-then-assert.ts:widenedBinding]
- `no-widen-then-assert` treats as broad: `unknown` and `any` (`"top"`), `object`, and
  (`"record"`) `Record<K, unknown>` or `Record<K, any>` with a broad key `K` (`string`,
  `number`, `symbol`, `PropertyKey` or a union of those), optionally inside `Readonly<...>`, or
  a type literal whose only member is an index signature with a broad key and an `unknown` or
  `any` value. `{}` is not broad. [anti-slop/rules/no-widen-then-assert.ts:broadTypeKind]
  [anti-slop/rules/no-widen-then-assert.ts:isBroadRecordType]
  [anti-slop/rules/no-widen-then-assert.ts:isBroadRecordKeyType]
- `no-widen-then-assert` never reports an assertion back to a broad type. The assertion, the
  declarator and any evidence variable must share one function boundary.
  [anti-slop/rules/no-widen-then-assert.ts:assertionIsNarrower] [anti-slop/rules/no-widen-then-assert.ts:functionBoundary]
- `require-safety-comment-for-type-assertion` looks for the comment before the assertion,
  then before each ancestor. It stops after the first `ExpressionStatement`,
  `PropertyDefinition`, `ReturnStatement`, `ThrowStatement` or `VariableDeclaration`, or after
  a node whose parent is `Program`. The comment must end before the assertion starts.
  [anti-slop/rules/require-safety-comment-for-type-assertion.ts:hasSafetyComment]
  [anti-slop/rules/require-safety-comment-for-type-assertion.ts:commentOwnerKinds]

### Shared helpers

- The built-in names are `Record`, `Readonly`, `Partial`, `Required`, `Pick`, `Omit`,
  `PropertyKey` and `NonNullable`. A name gets built-in handling only when it is not in
  `shadowedBuiltIns`. [anti-slop/shared/dictionary-types.ts:BUILT_INS] [anti-slop/shared/dictionary-types.ts:isBuiltIn]
- `shadowedBuiltIns` holds built-in names that a top-level import, type alias, interface,
  enum, class or function declares, plus any type alias name declared more than once.
  [anti-slop/shared/dictionary-types.ts:createTypeEnvironment]
- `Readonly`, `Partial`, `Required` and `NonNullable` are transparent wrappers: the
  classifiers look through them to their first type argument.
  [anti-slop/shared/dictionary-types.ts:TRANSPARENT_WRAPPERS]
- An unsafe value is `unknown`, `any`, `object`, an effectively empty type literal or
  interface, a union with at least one unsafe member, or an intersection with an `any`
  member or with only unsafe members. Local aliases and substituted type parameters are
  followed. [anti-slop/shared/dictionary-types.ts:unsafeDirectValue]
- A type literal is effectively empty when it has no members, or only optional properties
  typed `never`. An interface is effectively empty only with a single declaration, no
  `extends`, and such a body. [anti-slop/shared/dictionary-types.ts:isEffectivelyEmptyTypeLiteral]
  [anti-slop/shared/dictionary-types.ts:isEffectivelyEmptyInterface]
- Dictionary value types come from index signatures in type literals, mapped type
  annotations, and the second argument of `Record`. `Pick`, `Omit` and transparent wrappers
  recurse into their first argument. Interfaces do not count as dictionaries here (the
  rule checks interface index signatures separately, see Invariants, Rules).
  [anti-slop/shared/dictionary-types.ts:dictionaryValueTypes]
- Generic alias substitution maps parameters by position to arguments or defaults, and
  fails when a parameter has neither. [anti-slop/shared/dictionary-types.ts:aliasSubstitution]
- Alias recursion carries a set of aliases being resolved, and stops when a name repeats.
  [anti-slop/shared/dictionary-types.ts:unsafeDirectValue] [anti-slop/shared/dictionary-types.ts:resolvedSubstitutionArgument]
- Inside a non-generic alias, a type literal without an index signature is not a widening
  target, and a mapped type is one only when its key is broad (`string`, `number`, `symbol`,
  `PropertyKey`, or a union of those). [anti-slop/shared/dictionary-types.ts:classifyAliasBroadTarget]
  [anti-slop/shared/dictionary-types.ts:isBroadMappedKey]
- Qualified type names such as `A.B` are never treated as aliases or built-ins.
  [anti-slop/shared/dictionary-types.ts:typeReferenceName]
- `Reflect` is global when it is a global reference, has no variable in the scope chain, or has
  a variable with no definitions. [anti-slop/shared/reflect-method.ts:isGlobalReflect]
  [anti-slop/shared/reflect-method.ts:resolveVariable]

## Side Effects

- Loading `index.ts` imports the 15 rule modules and calls `eslintCompatPlugin` once. It does
  no I/O. [anti-slop/index.ts:antiSlopPlugin]
- The rules emit diagnostics only through `context.report`. No rule file reads or writes files
  or uses the network. [anti-slop/rules/no-chained-type-assertions.ts:noChainedTypeAssertionsRule]
- Some rules keep per-file state in their `createOnce` closure and reset it on each `Program`
  visit: an alias map in `no-object-parameters`, `no-unknown-returns` and
  `no-unknown-type-aliases`, a `TypeEnvironment` in `no-known-value-widening` and
  `no-unsafe-dictionary-type`, and the scope list in `no-widen-then-assert`.
  [anti-slop/rules/no-object-parameters.ts:noObjectParametersRule] [anti-slop/rules/no-unknown-returns.ts:noUnknownReturnsRule]
  [anti-slop/rules/no-unknown-type-aliases.ts:noUnknownTypeAliasesRule]
  [anti-slop/rules/no-known-value-widening.ts:noKnownValueWideningRule]
  [anti-slop/rules/no-unsafe-dictionary-type.ts:noUnsafeDictionaryTypeRule]
  [anti-slop/rules/no-widen-then-assert.ts:noWidenThenAssertRule]
- The shared helpers have no side effects. They read the AST and scope manager and return
  new values. The module-level sets are only read. [anti-slop/shared/dictionary-types.ts:BUILT_INS] [anti-slop/shared/reflect-method.ts:resolveVariable]

## Verification

- Run: `pnpm lint`
- The root `lint` script runs `oxlint` [../../package.json:scripts], which loads this plugin
  through `jsPlugins` [../../.oxlintrc.json:jsPlugins]. The plugin source itself is excluded
  from linting [../../.oxlintrc.json:ignorePatterns]. This repo has no unit tests for these
  rules or helpers.
