import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderReviewLoopSimulationReport,
  runReviewLoopSimulations
} from '../src/reviewLoopSimulation';

describe('review-loop simulation', () => {
  it('runs AI reviewer and human author scenarios and collects actionable feedback', () => {
    const summary = runReviewLoopSimulations();

    assert.equal(summary.scenarios.length, 7);
    assert.ok(summary.totalTurns >= 23);
    assert.equal(summary.feedback.length, 16);
    assert.deepEqual(summary.feedbackBySeverity, {
      high: 5,
      medium: 8,
      low: 3
    });
    assert.deepEqual(summary.repeatedThemes.slice(0, 3), [
      { theme: 'Patch application clarity', count: 4 },
      { theme: 'AI handoff continuity', count: 2 },
      { theme: 'Anchor preservation visibility', count: 3 }
    ].sort((left, right) => right.count - left.count || left.theme.localeCompare(right.theme)));
    assert.ok(summary.repeatedThemes.some(item => item.theme === 'Closure ownership'));
    assert.ok(summary.feedback.some(item => item.recommendation.includes('reply-quality warnings')));
    assert.ok(summary.feedback.some(item => item.recommendation.includes('human-gated')));
  });

  it('renders a stable report that includes scenarios, turns, and recommendations', () => {
    const report = renderReviewLoopSimulationReport(runReviewLoopSimulations());

    assert.match(report, /# Review Loop Simulation Report/);
    assert.match(report, /Scenarios run: 7/);
    assert.match(report, /Turns simulated: 23/);
    assert.match(report, /Feedback items: 16/);
    assert.match(report, /Human disagrees with an AI suggested patch/);
    assert.match(report, /Human says "accept this suggestion"/);
    assert.match(report, /Apply Suggested Patch/);
    assert.match(report, /reply-quality warnings/);
    assert.match(report, /human-gated/);
  });
});
