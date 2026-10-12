import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

/** The typed failure of `exit`; throws if it succeeded or failed otherwise. */
export const failure = <A, E>(exit: Exit.Exit<A, E>): E =>
  Option.getOrThrowWith(
    Exit.findErrorOption(exit),
    () => new Error(`expected a typed failure, got ${String(exit)}`),
  );

/** The value of a successful `exit`; throws otherwise. */
export const success = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value;
  throw new Error(`expected a success, got ${String(exit)}`);
};
