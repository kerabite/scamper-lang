import { evaluateExp, stepExp, stepStmt } from './interp.js'
import { Env, Exp, Stmt, isStmtDone, Program, indexOfCurrentStmt, progToString } from './lang.js'
import { parseExp, parseProgram } from './parser.js'
import { detailsToResult, ok, Result } from './result.js'
import { scopeCheckExp, scopeCheckProgram } from './scope.js'

export * from './result.js'
export { expToString, stmtToString, progToString } from './lang.js'

export function compileProgram (src: string): Result<Program> {
  return parseProgram(src).andThen(prog =>
    detailsToResult(scopeCheckProgram(prog)).andThen(_ =>
      ok(prog)))
}

export function compileExpr (env: Env, src: string): Result<Exp> {
  return parseExp(src).andThen(e =>
    detailsToResult(scopeCheckExp(env, e)).andThen(_ =>
      ok(e)))
}

export class ProgramState {
  env: Env
  prog: Program

  constructor (prog: Program, env?: Env) {
    this.env = env || new Map()
    this.prog = prog
  }

  isFullyEvaluated (): boolean {
    return this.prog.every(isStmtDone)
  }

  step (): ProgramState {
    for (let i = 0; i < this.prog.length; i++) {
      const s = this.prog[i]
      if (!isStmtDone(s)) {
        // N.B., make sure to not mutate things, but instead, create a new
        // ProgramState with the updates.
        const result = stepStmt(this.env, s)
        const prog = [...this.prog]
        prog[i] = result[1]
        return new ProgramState(prog, result[0])
      }
    }
    return this
  }

  evaluate (): ProgramState {
    let st: ProgramState = this
    while (!st.isFullyEvaluated()) {
      st = st.step()
    }
    return st
  }

  stepExp (e: Exp): Result<Exp> {
    return stepExp(this.env, e)
  }

  evaluateExp (e: Exp): Result<Exp> {
    return evaluateExp(this.env, e)
  }

  toString (): string {
    return progToString(this.prog)
  }
}

export class ProgramTrace {
  states: ProgramState[]
  pos: number

  constructor (initial: ProgramState) {
    this.states = [initial]
    this.pos = 0
  }

  getCurrentState (): ProgramState {
    return this.states[this.pos]
  }

  stepForward (): void {
    const lastI = this.states.length - 1
    if (this.pos === lastI && !this.states[lastI].isFullyEvaluated()) {
      this.states.push(this.states[lastI].step())
      this.pos += 1
    } else if (this.pos < lastI) {
      this.pos += 1
    }
    // N.B., if we're on the last state and it is fully evaluated, then we
    // do not advance forward.
  }

  stepBackward (): void {
    if (this.pos > 0) {
      this.pos--
    }
  }

  evalNextStmt (): void {
    if (this.getCurrentState().isFullyEvaluated()) { return }
    const i = indexOfCurrentStmt(this.getCurrentState().prog)
    while (indexOfCurrentStmt(this.getCurrentState().prog) === i) {
      this.stepForward()
    }
  }

  revertPrevStmt (): void {
    const i = indexOfCurrentStmt(this.getCurrentState().prog)
    while (indexOfCurrentStmt(this.getCurrentState().prog) === i && this.pos > 0) {
      this.stepBackward()
    }
  }

  evaluateProg (): void {
    while (!this.states[this.pos].isFullyEvaluated()) {
      this.stepForward()
    }
  }

  resetProg (): void {
    this.pos = 0
  }

  currentStep (): number {
    return this.pos + 1
  }

  currentState (): ProgramState {
    return this.states[this.pos]
  }

  addStmt (s: Stmt): void {
    this.states.forEach(st => st.prog.push(s))
  }
}
