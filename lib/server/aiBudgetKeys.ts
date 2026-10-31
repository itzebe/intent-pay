/**
 * Key names for the AI-budget counters.
 *
 * Kept in their own module so both the budget guard and the maintenance sweep
 * share one definition without pulling the LLM/cost modules into the rate
 * limiter's import graph. `aib:held:*` rows are per-window reservations and may
 * be swept once dead; `aib:spent:*` rows are per-month and must survive until the
 * month rolls, or a sweep would reset the budget.
 */

/** Per-window reservation counters: `aib:held:<month>:<windowIndex>`. */
export const HELD_PREFIX = "aib:held";
/** Per-month settled-spend counters: `aib:spent:<month>`. */
export const SPENT_PREFIX = "aib:spent";
