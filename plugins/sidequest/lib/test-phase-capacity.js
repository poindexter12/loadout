"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var test_phase_capacity_exports = {};
__export(test_phase_capacity_exports, {
  baselineTestPhaseDurationMilliseconds: () => baselineTestPhaseDurationMilliseconds,
  calculateCaptureDeadlineMilliseconds: () => calculateCaptureDeadlineMilliseconds,
  calculateEffectiveTestWorkers: () => calculateEffectiveTestWorkers,
  calculateExpectedTestPhaseDurationMilliseconds: () => calculateExpectedTestPhaseDurationMilliseconds,
  calculateTestConcurrency: () => calculateTestConcurrency,
  calculateTestPhaseTimeoutMilliseconds: () => calculateTestPhaseTimeoutMilliseconds,
  maximumTestConcurrency: () => maximumTestConcurrency,
  maximumTestPhaseTimeoutMilliseconds: () => maximumTestPhaseTimeoutMilliseconds,
  minimumEffectiveTestWorkers: () => minimumEffectiveTestWorkers,
  phaseBudgetOverrideVariable: () => phaseBudgetOverrideVariable,
  resolvePhaseBudgetOverride: () => resolvePhaseBudgetOverride,
  testPhaseBudgetSafetyFactor: () => testPhaseBudgetSafetyFactor
});
module.exports = __toCommonJS(test_phase_capacity_exports);
const minimumTestConcurrency = 2;
const maximumTestConcurrency = 8;
const baselineTestPhaseDurationMilliseconds = 96e4;
const testPhaseBudgetSafetyFactor = 1.5;
const maximumTestPhaseTimeoutMilliseconds = 36e5;
const minimumEffectiveTestWorkers = 0.5;
const phaseBudgetOverrideVariable = "SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS";
function calculateTestConcurrency(availableParallelism) {
  return Math.min(maximumTestConcurrency, Math.max(minimumTestConcurrency, availableParallelism));
}
function calculateEffectiveTestWorkers(testConcurrency, availableParallelism, loadAverage) {
  const otherRunnableThreads = Number.isFinite(loadAverage) && loadAverage > 0 ? loadAverage : 0;
  const contendedCoreShare = availableParallelism * testConcurrency / (testConcurrency + otherRunnableThreads);
  return Math.min(testConcurrency, Math.max(minimumEffectiveTestWorkers, contendedCoreShare));
}
function calculateExpectedTestPhaseDurationMilliseconds(testConcurrency, availableParallelism = testConcurrency, loadAverage = 0) {
  const effectiveTestWorkers = calculateEffectiveTestWorkers(testConcurrency, availableParallelism, loadAverage);
  const capacityScale = maximumTestConcurrency / effectiveTestWorkers;
  return Math.round(baselineTestPhaseDurationMilliseconds * capacityScale);
}
function calculateTestPhaseTimeoutMilliseconds(testConcurrency, availableParallelism = testConcurrency, loadAverage = 0) {
  const expectedDurationMilliseconds = calculateExpectedTestPhaseDurationMilliseconds(
    testConcurrency,
    availableParallelism,
    loadAverage
  );
  return Math.min(
    maximumTestPhaseTimeoutMilliseconds,
    Math.round(expectedDurationMilliseconds * testPhaseBudgetSafetyFactor)
  );
}
function calculateCaptureDeadlineMilliseconds(phaseBudgetMilliseconds, setupAllowanceMilliseconds) {
  return phaseBudgetMilliseconds + setupAllowanceMilliseconds;
}
function resolvePhaseBudgetOverride(measuredTimeoutMilliseconds, rawOverride) {
  const requestedText = typeof rawOverride === "string" ? rawOverride.trim() : "";
  if (requestedText === "") {
    return Object.freeze({
      timeoutMilliseconds: measuredTimeoutMilliseconds,
      requestedMilliseconds: null,
      widened: false,
      notice: null
    });
  }
  const requested = Number(requestedText);
  if (!Number.isInteger(requested) || requested <= 0) {
    return Object.freeze({
      timeoutMilliseconds: measuredTimeoutMilliseconds,
      requestedMilliseconds: null,
      widened: false,
      notice: `${phaseBudgetOverrideVariable}=${requestedText} is not a positive whole number of milliseconds, so the measured ${measuredTimeoutMilliseconds}ms phase budget stands.`
    });
  }
  if (requested <= measuredTimeoutMilliseconds) {
    return Object.freeze({
      timeoutMilliseconds: measuredTimeoutMilliseconds,
      requestedMilliseconds: requested,
      widened: false,
      notice: `${phaseBudgetOverrideVariable}=${requested} cannot shorten the measured ${measuredTimeoutMilliseconds}ms phase budget, so the measured budget stands. The override only ever grants more wall clock.`
    });
  }
  return Object.freeze({
    timeoutMilliseconds: requested,
    requestedMilliseconds: requested,
    widened: true,
    notice: `${phaseBudgetOverrideVariable} raised the phase budget from a measured ${measuredTimeoutMilliseconds}ms to ${requested}ms. Every test still has to pass inside it: this grants wall clock, it does not skip the gate.`
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  baselineTestPhaseDurationMilliseconds,
  calculateCaptureDeadlineMilliseconds,
  calculateEffectiveTestWorkers,
  calculateExpectedTestPhaseDurationMilliseconds,
  calculateTestConcurrency,
  calculateTestPhaseTimeoutMilliseconds,
  maximumTestConcurrency,
  maximumTestPhaseTimeoutMilliseconds,
  minimumEffectiveTestWorkers,
  phaseBudgetOverrideVariable,
  resolvePhaseBudgetOverride,
  testPhaseBudgetSafetyFactor
});
