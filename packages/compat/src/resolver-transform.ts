import {
  default as Resolver,
  ComponentResolution,
  ComponentLocator,
  ResolutionFail,
  Resolution,
  ResolvedDep,
} from './resolver';
import type { ASTv1, ASTPluginBuilder, ASTPluginEnvironment, WalkerPath } from '@glimmer/syntax';
import type { WithJSUtils } from 'babel-plugin-ember-template-compilation';
import assertNever from 'assert-never';
import { explicitRelative } from '@embroider/core';
import { dirname } from 'path';

type Env = WithJSUtils<ASTPluginEnvironment> & {
  filename: string;
  contents: string;
  strict?: boolean;
  locals?: string[];
};

export interface Options {
  resolver: Resolver;
  patchHelpersBug: boolean;
}

// This is the AST transform that resolves components, helpers and modifiers at build time
export default function makeResolverTransform({ resolver, patchHelpersBug }: Options) {
  const resolverTransform: ASTPluginBuilder<Env> = env => {
    let {
      filename,
      contents,
      meta: { jsutils },
      syntax: { builders },
      strict,
      locals,
    } = env;

    let scopeStack = new ScopeStack();
    let emittedAMDDeps: Set<string> = new Set();

    function relativeToFile(absPath: string): string {
      return explicitRelative(dirname(filename), absPath);
    }

    // The first time we insert a component as a lexical binding
    //   - if there's no JS-scope collision with the name, we're going to bind the existing name
    //     - in this case, any subsequent invocations of the same component just got automatically fixed too
    //     - but that means we need to remember that we did this, in order to
    //       give those other invocation sites support for features like argumentsAreComponents. That is what
    //       emittedLexicalBindings is for.
    //   - else there is a JS-scope collision, we're going to bind a mangled name and rewrite the callsite
    //     - in this case, subequent callsites will get their own independent
    //       resolution and they will get correctly aggregated by the
    //       jsutils.bindImport logic.
    let emittedLexicalBindings: Map<string, Resolution> = new Map();

    function emitAMD(dep: ResolvedDep | null) {
      if (dep && !emittedAMDDeps.has(dep.runtimeName)) {
        let parts = dep.runtimeName.split('/');
        let { absPath, runtimeName } = dep;
        jsutils.emitExpression(context => {
          let identifier = context.import(relativeToFile(absPath), 'default', parts[parts.length - 1]);
          return `window.define("${runtimeName}", () => ${identifier})`;
        });
        emittedAMDDeps.add(dep.runtimeName);
      }
    }

    function emit<Target extends WalkerPath<ASTv1.Node>>(
      parentPath: Target,
      resolution: Resolution | null,
      setter: (target: Target['node'], newIdentifier: ASTv1.PathExpression) => void
    ) {
      switch (resolution?.type) {
        case 'error':
          resolver.reportError(resolution, filename, contents);
          return;
        case 'helper':
          if (patchHelpersBug) {
            // lexical invocation of helpers was not reliable before Ember 4.2 due to https://github.com/emberjs/ember.js/pull/19878
            emitAMD(resolution.module);
          } else {
            let name = jsutils.bindImport(relativeToFile(resolution.module.absPath), 'default', parentPath, {
              nameHint: resolution.nameHint,
            });
            emittedLexicalBindings.set(name, resolution);
            setter(parentPath.node, builders.path(name));
          }
          return;
        case 'modifier':
          let name = jsutils.bindImport(relativeToFile(resolution.module.absPath), 'default', parentPath, {
            nameHint: resolution.nameHint,
          });
          emittedLexicalBindings.set(name, resolution);
          setter(parentPath.node, builders.path(name));
          return;
        case 'component':
          // When people are using octane-style template co-location or
          // polaris-style first-class templates, we see only JS files for their
          // components, because the template association is handled before
          // we're doing any resolving here. In that case, we can safely do
          // component invocation via lexical scope.
          //
          // But when people are using the older non-co-located template style,
          // we can't safely do that -- ember needs to discover both the
          // component and the template in the AMD loader to associate them. In
          // that case, we emit just-in-time AMD definitions for them.
          if (resolution.jsModule && !resolution.hbsModule) {
            let name = jsutils.bindImport(relativeToFile(resolution.jsModule.absPath), 'default', parentPath, {
              nameHint: resolution.nameHint,
            });
            emittedLexicalBindings.set(name, resolution);
            setter(parentPath.node, builders.path(name));
          } else {
            emitAMD(resolution.hbsModule);
            emitAMD(resolution.jsModule);
          }
        case undefined:
          return;
        default:
          assertNever(resolution);
      }
    }

    function handleDynamicComponentArguments(
      componentName: string,
      argumentsAreComponents: string[],
      attributes: WalkerPath<ASTv1.AttrNode | ASTv1.HashPair>[]
    ) {
      for (let name of argumentsAreComponents) {
        let attr = attributes.find(attr => {
          if (attr.node.type === 'AttrNode') {
            return attr.node.name === '@' + name;
          } else {
            return attr.node.key === name;
          }
        });
        if (attr) {
          let resolution = handleComponentHelper(attr.node.value, resolver, filename, scopeStack, {
            componentName,
            argumentName: name,
          });
          emit(attr, resolution, (node, newId) => {
            if (node.type === 'AttrNode') {
              node.value = builders.mustache(newId);
            } else {
              node.value = newId;
            }
          });
        }
      }
    }

    if (strict) {
      return {
        name: 'embroider-build-time-resolver-strict-noop',
        visitor: {},
      };
    }

    return {
      name: 'embroider-build-time-resolver',

      visitor: {
        Program: {
          enter(node) {
            if (locals) {
              scopeStack.push(locals);
            }
            scopeStack.push(node.blockParams);
          },
          exit() {
            scopeStack.pop();
            if (locals) {
              scopeStack.pop();
            }
          },
        },
        BlockStatement(node, path) {
          if (node.path.type !== 'PathExpression') {
            return;
          }
          let rootName = node.path.parts[0];
          if (scopeStack.inScope(rootName)) {
            let resolution = emittedLexicalBindings.get(rootName);
            if (resolution?.type === 'component') {
              scopeStack.enteringComponentBlock(resolution, ({ argumentsAreComponents }) => {
                handleDynamicComponentArguments(
                  rootName,
                  argumentsAreComponents,
                  extendPath(extendPath(path, 'hash'), 'pairs')
                );
              });
            }
            return;
          }
          if (node.path.this === true) {
            return;
          }
          if (node.path.parts.length > 1) {
            // paths with a dot in them (which therefore split into more than
            // one "part") are classically understood by ember to be contextual
            // components, which means there's nothing to resolve at this
            // location.
            return;
          }
          if (node.path.original === 'component' && node.params.length > 0) {
            let resolution = handleComponentHelper(node.params[0], resolver, filename, scopeStack);
            emit(path, resolution, (node, newIdentifier) => {
              node.params[0] = newIdentifier;
            });
            return;
          }
          // a block counts as args from our perpsective (it's enough to prove
          // this thing must be a component, not content)
          let hasArgs = true;
          let resolution = resolver.resolveMustache(node.path.original, hasArgs, filename, node.path.loc);
          emit(path, resolution, (node, newId) => {
            node.path = newId;
          });
          if (resolution?.type === 'component') {
            scopeStack.enteringComponentBlock(resolution, ({ argumentsAreComponents }) => {
              handleDynamicComponentArguments(
                rootName,
                argumentsAreComponents,
                extendPath(extendPath(path, 'hash'), 'pairs')
              );
            });
          }
        },
        SubExpression(node, path) {
          if (node.path.type !== 'PathExpression') {
            return;
          }
          if (node.path.this === true) {
            return;
          }
          if (scopeStack.inScope(node.path.parts[0])) {
            return;
          }
          if (node.path.original === 'component' && node.params.length > 0) {
            let resolution = handleComponentHelper(node.params[0], resolver, filename, scopeStack);
            emit(path, resolution, (node, newId) => {
              node.params[0] = newId;
            });
            return;
          }
          if (node.path.original === 'helper' && node.params.length > 0) {
            handleDynamicHelper(node.params[0], resolver, filename);
            return;
          }
          if (node.path.original === 'modifier' && node.params.length > 0) {
            handleDynamicModifier(node.params[0], resolver, filename);
            return;
          }
          let resolution = resolver.resolveSubExpression(node.path.original, filename, node.path.loc);
          emit(path, resolution, (node, newId) => {
            node.path = newId;
          });
        },
        MustacheStatement: {
          enter(node, path) {
            if (node.path.type !== 'PathExpression') {
              return;
            }
            let rootName = node.path.parts[0];
            if (scopeStack.inScope(rootName)) {
              let resolution = emittedLexicalBindings.get(rootName);
              if (resolution && resolution.type === 'component') {
                handleDynamicComponentArguments(
                  rootName,
                  resolution.argumentsAreComponents,
                  extendPath(extendPath(path, 'hash'), 'pairs')
                );
              }
              return;
            }
            if (node.path.this === true) {
              return;
            }
            if (node.path.parts.length > 1) {
              // paths with a dot in them (which therefore split into more than
              // one "part") are classically understood by ember to be contextual
              // components, which means there's nothing to resolve at this
              // location.
              return;
            }
            if (node.path.original === 'component' && node.params.length > 0) {
              let resolution = handleComponentHelper(node.params[0], resolver, filename, scopeStack);
              emit(path, resolution, (node, newId) => {
                node.params[0] = newId;
              });
              return;
            }
            if (node.path.original === 'helper' && node.params.length > 0) {
              handleDynamicHelper(node.params[0], resolver, filename);
              return;
            }
            let hasArgs = node.params.length > 0 || node.hash.pairs.length > 0;
            let resolution = resolver.resolveMustache(node.path.original, hasArgs, filename, node.path.loc);
            emit(path, resolution, (node, newIdentifier) => {
              node.path = newIdentifier;
            });
            if (resolution?.type === 'component') {
              handleDynamicComponentArguments(
                node.path.original,
                resolution.argumentsAreComponents,
                extendPath(extendPath(path, 'hash'), 'pairs')
              );
            }
          },
        },
        ElementModifierStatement(node, path) {
          if (node.path.type !== 'PathExpression') {
            return;
          }
          if (scopeStack.inScope(node.path.parts[0])) {
            return;
          }
          if (node.path.this === true) {
            return;
          }
          if (node.path.data === true) {
            return;
          }
          if (node.path.parts.length > 1) {
            // paths with a dot in them (which therefore split into more than
            // one "part") are classically understood by ember to be contextual
            // components. With the introduction of `Template strict mode` in Ember 3.25
            // it is also possible to pass modifiers this way which means there's nothing
            // to resolve at this location.
            return;
          }

          let resolution = resolver.resolveElementModifierStatement(node.path.original, filename, node.path.loc);
          emit(path, resolution, (node, newId) => {
            node.path = newId;
          });
        },
        ElementNode: {
          enter(node, path) {
            let rootName = node.tag.split('.')[0];
            if (scopeStack.inScope(rootName)) {
              const resolution = emittedLexicalBindings.get(rootName);
              if (resolution?.type === 'component') {
                scopeStack.enteringComponentBlock(resolution, ({ argumentsAreComponents }) => {
                  handleDynamicComponentArguments(node.tag, argumentsAreComponents, extendPath(path, 'attributes'));
                });
              }
            } else {
              const resolution = resolver.resolveElement(node.tag, filename, node.loc);
              emit(path, resolution, (node, newId) => {
                node.tag = newId.original;
              });
              if (resolution?.type === 'component') {
                scopeStack.enteringComponentBlock(resolution, ({ argumentsAreComponents }) => {
                  handleDynamicComponentArguments(node.tag, argumentsAreComponents, extendPath(path, 'attributes'));
                });
              }
            }
            scopeStack.push(node.blockParams);
          },
          exit() {
            scopeStack.pop();
          },
        },
      },
    };
  };
  (resolverTransform as any).parallelBabel = {
    requireFile: __filename,
    buildUsing: 'makeResolverTransform',
    params: Resolver,
  };
  return resolverTransform;
}

interface ComponentBlockMarker {
  type: 'componentBlockMarker';
  resolution: ComponentResolution;
  argumentsAreComponents: string[];
  exit: (marker: ComponentBlockMarker) => void;
}

type ScopeEntry = { type: 'blockParams'; blockParams: string[] } | ComponentBlockMarker;

class ScopeStack {
  private stack: ScopeEntry[] = [];

  // as we enter a block, we push the block params onto here to mark them as
  // being in scope
  push(blockParams: string[]) {
    this.stack.unshift({ type: 'blockParams', blockParams });
  }

  // and when we leave the block they go out of scope. If this block was tagged
  // by a safe component marker, we also clear that.
  pop() {
    this.stack.shift();
    let next = this.stack[0];
    if (next && next.type === 'componentBlockMarker') {
      next.exit(next);
      this.stack.shift();
    }
  }

  // right before we enter a block, we might determine that some of the values
  // that will be yielded as marked (by a rule) as safe to be used with the
  // {{component}} helper.
  enteringComponentBlock(resolution: ComponentResolution, exit: ComponentBlockMarker['exit']) {
    this.stack.unshift({
      type: 'componentBlockMarker',
      resolution,
      argumentsAreComponents: resolution.argumentsAreComponents.slice(),
      exit,
    });
  }

  inScope(name: string) {
    for (let scope of this.stack) {
      if (scope.type === 'blockParams' && scope.blockParams.includes(name)) {
        return true;
      }
    }
    return false;
  }

  safeComponentInScope(name: string): boolean {
    let parts = name.split('.');
    if (parts.length > 2) {
      // we let component rules specify that they yield components or objects
      // containing components. But not deeper than that. So the max path length
      // that can refer to a marked-safe component is two segments.
      return false;
    }
    for (let i = 0; i < this.stack.length - 1; i++) {
      let here = this.stack[i];
      let next = this.stack[i + 1];
      if (here.type === 'blockParams' && next.type === 'componentBlockMarker') {
        let positionalIndex = here.blockParams.indexOf(parts[0]);
        if (positionalIndex === -1) {
          continue;
        }

        if (parts.length === 1) {
          if (next.resolution.yieldsComponents[positionalIndex] === true) {
            return true;
          }
          let sourceArg = next.resolution.yieldsArguments[positionalIndex];
          if (typeof sourceArg === 'string') {
            next.argumentsAreComponents.push(sourceArg);
            return true;
          }
        } else {
          let entry = next.resolution.yieldsComponents[positionalIndex];
          if (entry && typeof entry === 'object') {
            return entry[parts[1]] === true;
          }

          let argsEntry = next.resolution.yieldsArguments[positionalIndex];
          if (argsEntry && typeof argsEntry === 'object') {
            let sourceArg = argsEntry[parts[1]];
            if (typeof sourceArg === 'string') {
              next.argumentsAreComponents.push(sourceArg);
              return true;
            }
          }
        }
        // we found the source of the name, but there were no rules to cover it.
        // Don't keep searching higher, those are different names.
        return false;
      }
    }
    return false;
  }
}

function handleComponentHelper(
  param: ASTv1.Node,
  resolver: Resolver,
  moduleName: string,
  scopeStack: ScopeStack,
  impliedBecause?: { componentName: string; argumentName: string }
): ComponentResolution | ResolutionFail | null {
  let locator: ComponentLocator;
  switch (param.type) {
    case 'StringLiteral':
      locator = { type: 'literal', path: param.value };
      break;
    case 'PathExpression':
      locator = { type: 'path', path: param.original };
      break;
    case 'MustacheStatement':
      if (param.hash.pairs.length === 0 && param.params.length === 0) {
        return handleComponentHelper(param.path, resolver, moduleName, scopeStack, impliedBecause);
      } else if (param.path.type === 'PathExpression' && param.path.original === 'component') {
        // safe because we will handle this inner `{{component ...}}` mustache on its own
        return null;
      } else {
        locator = { type: 'other' };
      }
      break;
    case 'TextNode':
      locator = { type: 'literal', path: param.chars };
      break;
    case 'SubExpression':
      if (param.path.type === 'PathExpression' && param.path.original === 'component') {
        // safe because we will handle this inner `(component ...)` subexpression on its own
        return null;
      }
      if (param.path.type === 'PathExpression' && param.path.original === 'ensure-safe-component') {
        // safe because we trust ensure-safe-component
        return null;
      }
      locator = { type: 'other' };
      break;
    default:
      locator = { type: 'other' };
  }

  if (locator.type === 'path' && scopeStack.safeComponentInScope(locator.path)) {
    return null;
  }

  return resolver.resolveComponentHelper(locator, moduleName, param.loc, impliedBecause);
}

function handleDynamicHelper(param: ASTv1.Expression, resolver: Resolver, moduleName: string): void {
  // We only need to handle StringLiterals since Ember already throws an error if unsupported values
  // are passed to the helper keyword.
  // If a helper reference is passed in we don't need to do anything since it's either the result of a previous
  // helper keyword invocation, or a helper reference that was imported somewhere.
  if (param.type === 'StringLiteral') {
    resolver.resolveDynamicHelper({ type: 'literal', path: param.value }, moduleName, param.loc);
  }
}

function handleDynamicModifier(param: ASTv1.Expression, resolver: Resolver, moduleName: string): void {
  if (param.type === 'StringLiteral') {
    resolver.resolveDynamicModifier({ type: 'literal', path: param.value }, moduleName, param.loc);
  }
}

function extendPath<N extends ASTv1.Node, K extends keyof N>(
  path: WalkerPath<N>,
  key: K
): N[K] extends ASTv1.Node ? WalkerPath<N[K]> : N[K] extends ASTv1.Node[] ? WalkerPath<N[K][0]>[] : never {
  const _WalkerPath = path.constructor as {
    new <Child extends ASTv1.Node>(
      node: Child,
      parent?: WalkerPath<ASTv1.Node> | null,
      parentKey?: string | null
    ): WalkerPath<Child>;
  };
  let child = path.node[key];
  if (Array.isArray(child)) {
    return child.map(c => new _WalkerPath(c, path, key as string)) as any;
  } else {
    return new _WalkerPath(child as any, path, key as string) as any;
  }
}
