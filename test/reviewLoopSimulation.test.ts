import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  renderReviewLoopSimulationReport,
  runReviewLoopSimulations
} from '../src/reviewLoopSimulation';

describe('review-loop simulation', () => {
  it('runs AI reviewer and human author scenarios and collects actionable feedback', () => {
    const summary = runReviewLoopSimulations();

    assert.equal(summary.fixturePath, 'test/fixtures/rich-review-loop-sample.md');
    assert.equal(summary.scenarios.length, 11);
    assert.equal(summary.totalTurns, 38);
    assert.equal(summary.reviewThreadCount, 11);
    assert.equal(summary.replyCount, 26);
    assert.equal(summary.feedback.length, 23);
    assert.deepEqual(summary.feedbackBySeverity, {
      high: 6,
      medium: 13,
      low: 4
    });
    assert.ok(summary.repeatedThemes.some(item => item.theme === 'Anchor preservation visibility'
      && item.count === 5));
    assert.ok(summary.repeatedThemes.some(item => item.theme === 'Patch application clarity'
      && item.count === 5));
    assert.ok(summary.repeatedThemes.some(item => item.theme === 'Closure ownership'));
    assert.ok(summary.feedback.some(item => item.recommendation.includes('reply-quality warnings')));
    assert.ok(summary.feedback.some(item => item.recommendation.includes('human-gated')));

    const allThreads = summary.scenarios.flatMap(scenario => scenario.reviewThreads);
    assert.ok(allThreads.some(thread => thread.id === 'rv_stale_patch'
      && thread.thread.some(reply => reply.text.includes('please revise against the current text'))));
    assert.ok(allThreads.some(thread => thread.id === 'rv_table_owner'
      && thread.thread.some(reply => reply.text.includes('table grid editor'))));
    assert.ok(allThreads.some(thread => thread.id === 'rv_mermaid_branch'
      && thread.thread.some(reply => reply.text.includes('sidecar sync'))));
    assert.ok(allThreads.some(thread => thread.id === 'rv_accept_language'
      && thread.status === 'accepted'
      && thread.closedBy === 'user'));
    assert.ok(allThreads.some(thread => thread.id === 'rv_remove_section'
      && thread.anchor.lineStart === 26
      && thread.anchor.occurrence === 2));
    assert.ok(allThreads.some(thread => thread.id === 'rv_mermaid_branch'
      && thread.anchor.lineStart === 52));
    assert.ok(allThreads.some(thread => thread.id === 'rv_source_anchor'
      && thread.anchor.confidence === 'approximate'));
  });

  it('renders a stable report that includes scenarios, turns, and recommendations', () => {
    const report = renderReviewLoopSimulationReport(runReviewLoopSimulations());

    assert.match(report, /# Review Loop Simulation Report/);
    assert.match(report, /Fixture: test\/fixtures\/rich-review-loop-sample\.md/);
    assert.match(report, /Scenarios run: 11/);
    assert.match(report, /Turns simulated: 38/);
    assert.match(report, /Review threads simulated: 11/);
    assert.match(report, /Thread replies simulated: 26/);
    assert.match(report, /Feedback items: 23/);
    assert.match(report, /Human disagrees with an AI suggested patch/);
    assert.match(report, /Human says "accept this suggestion"/);
    assert.match(report, /AI revises a stale suggested patch/);
    assert.match(report, /Human source-edits text with an open comment/);
    assert.match(report, /AI and human discuss a table-cell comment through a grid edit/);
    assert.match(report, /AI and human revise a Mermaid diagram comment/);
    assert.match(report, /Thread transcript/);
    assert.match(report, /rv_table_owner/);
    assert.match(report, /rv_mermaid_branch/);
    assert.match(report, /Apply Patch and Close/);
    assert.match(report, /sidecar watcher/);
    assert.match(report, /reply-quality warnings/);
    assert.match(report, /human-gated/);
  });

  it('keeps the rich Markdown fixture broad enough for review-loop dogfooding', async () => {
    const fixturePath = path.join(process.cwd(), 'test/fixtures/rich-review-loop-sample.md');
    const fixture = await readFile(fixturePath, 'utf8');

    assert.match(fixture, /^# Rich Review Loop Sample/m);
    assert.match(fixture, /\| Area \| Current text \| Review risk \| Owner \| Expected action \|/);
    assert.match(fixture, /```mermaid\nflowchart TD/);
    assert.match(fixture, /```mermaid\nsequenceDiagram/);
    assert.match(fixture, /\| Sidecar refresh \|[^\n]*\| Extension \|/);
    assert.match(fixture, /\| Table comments \|[^\n]*\| Extension \|/);
    assert.match(fixture, /^1\. Draft review policy\./m);
    assert.match(fixture, /- \[ \] Open the review preview beside this fixture\./);
    assert.match(fixture, /type ReviewDecision = 'accepted' \| 'resolved' \| 'rejected';/);
    assert.match(fixture, /This final paragraph must remain present/);
  });
});
