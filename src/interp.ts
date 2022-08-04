import { ecall, eif, elam, elet, epair, isValue, Exp, Env, Stmt, sexp, expToString, sbinding, svalue, serror, Name, econd, nlecond, eand, eor, nlebool, nleand, nleor } from './lang.js'
import { primMap } from './prims.js'
import { Result, error, ok, rethrow } from './result.js'
import { msg } from './messages.js'

function runtimeError <T> (message: string, s?: Exp, hint?: string): Result<T> {
  return s
    ? error(msg('phase-runtime'), message, s.range, expToString(s), hint)
    : error(msg('phase-runtime'), message, undefined, undefined, hint)
}

function namesInclude (names: Name[], x: string): boolean {
  return names.some(n => n.value === x)
}

function substitute (e1: Exp, x: string, e2: Exp): Exp {
  switch (e2.tag) {
    case 'var':
      return e2.value === x ? e1 : e2
    case 'lit':
      return e2
    case 'call':
      return ecall(e2.range, substitute(e1, x, e2.head), e2.args.map((e) => substitute(e1, x, e)))
    case 'lam':
      return namesInclude(e2.args, x) ? e2 : elam(e2.range, e2.args, substitute(e1, x, e2.body))
    case 'if':
      return eif(e2.range, substitute(e1, x, e2.e1), substitute(e1, x, e2.e2), substitute(e1, x, e2.e3))
    case 'nil':
      return e2
    case 'pair':
      return epair(e2.range, substitute(e1, x, e2.e1), substitute(e1, x, e2.e2))
    case 'let':
      return elet(e2.range, substituteTelescope(e1, x, e2.bindings), inBindings(x, e2.bindings) ? e2.body : substitute(e1, x, e2.body))
    case 'cond':
      return econd(e2.range, e2.branches.map(b => [substitute(e1, x, b[0]), substitute(e1, x, b[1])]))
    case 'and':
      return eand(e2.range, e2.args.map(e => substitute(e1, x, e)))
    case 'or':
      return eor(e2.range, e2.args.map(e => substitute(e1, x, e)))
  }
}

function inBindings (x: string, bindings: [Name, Exp][]): boolean {
  for (let i = 0; i < bindings.length; i++) {
    if (bindings[i][0].value === x) {
      return true
    }
  }
  return false
}

function substituteTelescope (e1: Exp, x: string, bindings: [Name, Exp][]): [Name, Exp][] {
  const result = new Array(bindings.length)
  let seenVar = false
  for (let i = 0; i < bindings.length; i++) {
    if (seenVar) {
      result[i] = bindings[i]
    } else if (bindings[i][0].value === x) {
      result[i] = bindings[i]
      seenVar = true
    } else {
      result[i] = [bindings[i][0], substitute(e1, x, bindings[i][1])]
    }
  }
  return result
}

function substituteAll (es: Exp[], xs: Name[], e: Exp) {
  for (let i = 0; i < es.length; i++) {
    e = substitute(es[i], xs[i].value, e)
  }
  return e
}

function stepExp (env: Env, e: Exp): Result<Exp> {
  switch (e.tag) {
    // TODO: need to reconcile variables with top-level bindings/env
    case 'var': {
      const x = e.value
      return env.has(x)
        ? ok(env.get(x)!)
        : runtimeError('Undefined variable.', e)
    }
    case 'lit':
      return ok(e)
    case 'call':
      // NOTE: we allow variables in head position so that (f x) works
      // where f is a top-level binding. If we change the infrastructure
      // of variables and substitution, we'll need to revisit this choice.
      if (!isValue(e.head) && !(e.head.tag === 'var')) {
        return stepExp(env, e.head).andThen(headp => stepExp(env, ecall(e.range, headp, e.args)))
      } else {
        // Try to stepExp one of the call's arguments
        for (let i = 0; i < e.args.length; i++) {
          if (!isValue(e.args[i])) {
            const argsp = [...e.args]
            return stepExp(env, argsp[i]).andThen(eip => {
              argsp[i] = eip
              return ok(ecall(e.range, e.head, argsp))
            })
          }
        }
        // If we did not stepExp any arguments, then evaluate the full call
        switch (e.head.tag) {
          case 'lam':
            if (e.args.length === e.head.args.length) {
              return ok(substituteAll(e.args, e.head.args, e.head.body))
            } else {
              return runtimeError(msg('error-arity', 'lambda', e.head.args.length, e.args.length), e)
            }
          case 'var':
            if (env.has(e.head.value)) {
              return stepExp(env, ecall(e.range, env.get(e.head.value)!, e.args))
            } else if (primMap.has(e.head.value)) {
              return primMap.get(e.head.value)!(e.head.value, e.args, e)
            } else {
              return runtimeError(msg('error-var-undef', e.head.value), e)
            }
          default:
            return runtimeError(msg('error-type-expected-call', e.head.tag, e))
        }
      }
    case 'lam':
      return ok(e)
    case 'if':
      if (!isValue(e.e1)) {
        return stepExp(env, e.e1).andThen(e1p => ok(eif(e.range, e1p, e.e2, e.e3)))
      } else {
        switch (e.e1.tag) {
          case 'lit':
            if (e.e1.value.tag === 'bool') {
              return e.e1.value.value ? ok(e.e2) : ok(e.e3)
            } else {
              return runtimeError(msg('error-type-expected-cond', e.e1.value.tag), e)
            }
          default:
            return runtimeError(msg('error-type-expected-cond', e.e1.tag), e)
        }
      }
    case 'nil':
      return ok(e)
    case 'pair':
      if (!isValue(e.e1)) {
        return stepExp(env, e.e1).andThen(e1p => ok(epair(e.range, e1p, e.e2)))
      } else if (!isValue(e.e2)) {
        return stepExp(env, e.e2).andThen(e2p => ok(epair(e.range, e.e1, e2p)))
      } else {
        return ok(e)
      }
    case 'let':
      if (e.bindings.length > 0) {
        const x = e.bindings[0][0]
        const e1 = e.bindings[0][1]
        if (!isValue(e1)) {
          return stepExp(env, e1).andThen(e1p => {
            const bindings = [...e.bindings]
            bindings[0] = [x, e1p]
            return ok(elet(e.range, bindings, e.body))
          })
        } else {
          return e.bindings.length === 1
            ? ok(substitute(e1, x.value, e.body))
            : ok(elet(e.range, substituteTelescope(e1, x.value, e.bindings.slice(1)), substitute(e1, x.value, e.body)))
        }
      } else {
        return ok(e.body)
      }
    case 'cond':
      if (e.branches.length === 0) {
        return runtimeError(msg('error-cond-no-branch-applies'), e)
      } else {
        const guard = e.branches[0][0]
        const body = e.branches[0][1]
        if (isValue(e.branches[0][0])) {
          if (guard.tag === 'lit' && guard.value.tag === 'bool' && guard.value.value === true) {
            return ok(body)
          } else if (guard.tag === 'lit' && guard.value.tag === 'bool' && guard.value.value === false) {
            return ok(nlecond([...e.branches.slice(1)]))
          } else {
            return runtimeError(msg('error-type-expected-cond', guard.tag), e)
          }
        } else {
          return stepExp(env, guard).andThen(guardp =>
            ok(nlecond([[guardp, body], ...e.branches.slice(1)])))
        }
      }
    case 'and':
      if (e.args.length === 0) {
        return ok(nlebool(true))
      } else {
        const head = e.args[0]
        if (isValue(head)) {
          if (head.tag === 'lit' && head.value.tag === 'bool') {
            return head.value.value
              ? ok(nleand([...e.args.slice(1)]))
              : ok(nlebool(false))
          } else {
            return runtimeError(msg('error-type-expected', 'bool', head.tag), e)
          }
        } else {
          return stepExp(env, head).andThen(headp =>
            ok(nleand([headp, ...e.args.slice(1)])))
        }
      }
    // N.B., or is identical to and expect dualized---factor redundancy?
    case 'or':
      if (e.args.length === 0) {
        return ok(nlebool(false))
      } else {
        const head = e.args[0]
        if (isValue(head)) {
          if (head.tag === 'lit' && head.value.tag === 'bool') {
            return !head.value.value
              ? ok(nleor([...e.args.slice(1)]))
              : ok(nlebool(true))
          } else {
            return runtimeError(msg('error-type-expected', 'bool', head.tag), e)
          }
        } else {
          return stepExp(env, head).andThen(headp =>
            ok(nleor([headp, ...e.args.slice(1)])))
        }
      }
  }
}

function evaluateExp (env: Env, e:Exp) : Result<Exp> {
  while (!isValue(e)) {
    // TODO: need to check whether e == stepExp(e), i.e., we're in a loop
    const result = stepExp(env, e)
    switch (result.tag) {
      case 'error':
        return rethrow(result)
      case 'ok':
        e = result.value
    }
  }
  return ok(e)
}

function stepStmt (env: Env, s: Stmt): [Env, Stmt] {
  switch (s.tag) {
    case 'error':
      return [env, s]
    case 'binding':
      return [env, s]
    case 'value':
      return [env, s]
    case 'define':
      if (isValue(s.value)) {
        const envp = new Map(env)
        envp.set(s.name.value, s.value)
        return [envp, sbinding(s.name.value, s.value)]
      } else {
        const result = stepExp(env, s.value)
        switch (result.tag) {
          case 'error':
            return [env, serror(result.details)]
          case 'ok':
            return [env, sbinding(s.name.value, result.value)]
        }
      }
      /* eslint-disable no-fallthrough */
    case 'exp':
      if (isValue(s.value)) {
        return [env, svalue(s.value)]
      } else {
        const result = stepExp(env, s.value)
        switch (result.tag) {
          case 'error':
            return [env, serror(result.details)]
          case 'ok':
            return [env, sexp(result.value)]
        }
      }
  }
}

export {
  runtimeError, substitute,
  stepExp, stepStmt, evaluateExp
}
