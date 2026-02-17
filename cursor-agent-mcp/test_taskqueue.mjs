#!/usr/bin/env node
/**
 * Tests for TaskQueue class
 */

import { TaskQueue } from './TaskQueue.js';

const log = (test, msg) => console.log(`[${test}] ${msg}`);
const assert = (condition, message) => {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
};

// Test 1: Concurrency limiting
async function testConcurrencyLimiting() {
  log('TEST 1', 'Testing concurrency limiting...');
  
  const concurrency = 2;
  const queue = new TaskQueue(concurrency);
  
  const startTimes = [];
  const endTimes = [];
  
  // Create 5 tasks that each take 100ms
  const tasks = Array.from({ length: 5 }, (_, i) => 
    queue.add(async () => {
      startTimes.push({ id: i, time: Date.now() });
      await new Promise(resolve => setTimeout(resolve, 100));
      endTimes.push({ id: i, time: Date.now() });
      return i;
    })
  );
  
  await queue.waitAll();
  
  // Check that at most 'concurrency' tasks ran simultaneously
  // We'll verify by checking start times - first 2 should start close together,
  // then next 2 should start after first 2 finish
  const sortedStarts = startTimes.sort((a, b) => a.time - b.time);
  const sortedEnds = endTimes.sort((a, b) => a.time - b.time);
  
  // First two should start almost simultaneously (within 50ms)
  const firstTwoStartDiff = sortedStarts[1].time - sortedStarts[0].time;
  assert(firstTwoStartDiff < 50, 'First two tasks should start almost simultaneously');
  
  // Third task should start after first task finishes (within 50ms)
  const thirdStartAfterFirstEnd = sortedStarts[2].time - sortedEnds[0].time;
  assert(thirdStartAfterFirstEnd < 50, 'Third task should start after first task finishes');
  
  // Verify all tasks completed
  const results = await Promise.all(tasks);
  assert(results.length === 5, 'All 5 tasks should complete');
  assert(results.every((r, i) => r === i), 'All tasks should return correct results');
  
  log('TEST 1', '✓ PASS - Concurrency limiting works correctly');
}

// Test 2: Pause/Resume
async function testPauseResume() {
  log('TEST 2', 'Testing pause/resume...');
  
  const queue = new TaskQueue(2);
  const executionOrder = [];
  
  // Add first task that completes quickly
  const task1 = queue.add(async () => {
    executionOrder.push('task1-start');
    await new Promise(resolve => setTimeout(resolve, 50));
    executionOrder.push('task1-end');
    return 1;
  });
  
  // Pause before adding more tasks
  queue.pause();
  
  // Add second task - should be queued but not executed
  const task2 = queue.add(async () => {
    executionOrder.push('task2-start');
    await new Promise(resolve => setTimeout(resolve, 50));
    executionOrder.push('task2-end');
    return 2;
  });
  
  // Wait a bit to ensure task2 doesn't start
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Verify task1 completed but task2 hasn't started
  assert(executionOrder.includes('task1-start'), 'Task1 should start');
  assert(executionOrder.includes('task1-end'), 'Task1 should complete');
  assert(!executionOrder.includes('task2-start'), 'Task2 should not start while paused');
  
  // Resume and wait for all tasks
  queue.resume();
  await queue.waitAll();
  
  // Verify task2 executed after resume
  assert(executionOrder.includes('task2-start'), 'Task2 should start after resume');
  assert(executionOrder.includes('task2-end'), 'Task2 should complete');
  
  // Verify results
  const [result1, result2] = await Promise.all([task1, task2]);
  assert(result1 === 1, 'Task1 should return correct result');
  assert(result2 === 2, 'Task2 should return correct result');
  
  log('TEST 2', '✓ PASS - Pause/resume works correctly');
}

// Test 3: onTaskComplete callback
async function testOnTaskComplete() {
  log('TEST 3', 'Testing onTaskComplete callback...');
  
  const completedTasks = [];
  const errors = [];
  
  const queue = new TaskQueue(2, {
    onTaskComplete: (error, result) => {
      if (error) {
        errors.push(error);
      } else {
        completedTasks.push(result);
      }
    }
  });
  
  // Add successful tasks
  await queue.add(async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return 'success1';
  });
  
  await queue.add(async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return 'success2';
  });
  
  // Add a failing task
  await queue.add(async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    throw new Error('task failed');
  }).catch(() => {
    // Expected error
  });
  
  await queue.waitAll();
  
  // Verify callback was called for all tasks
  assert(completedTasks.length === 2, 'Callback should be called for 2 successful tasks');
  assert(completedTasks.includes('success1'), 'Callback should receive success1');
  assert(completedTasks.includes('success2'), 'Callback should receive success2');
  assert(errors.length === 1, 'Callback should be called for 1 failed task');
  assert(errors[0].message === 'task failed', 'Callback should receive correct error');
  
  log('TEST 3', '✓ PASS - onTaskComplete callback works correctly');
}

// Run all tests
async function runTests() {
  console.log('═'.repeat(60));
  console.log('TaskQueue Tests');
  console.log('═'.repeat(60));
  console.log('');
  
  try {
    await testConcurrencyLimiting();
    console.log('');
    await testPauseResume();
    console.log('');
    await testOnTaskComplete();
    console.log('');
    console.log('═'.repeat(60));
    console.log('All tests passed! ✓');
    console.log('═'.repeat(60));
    process.exit(0);
  } catch (error) {
    console.error('');
    console.error('═'.repeat(60));
    console.error('Test failed:', error.message);
    console.error('═'.repeat(60));
    process.exit(1);
  }
}

runTests();
