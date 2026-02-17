import { retryWithBackoff } from './retryWithBackoff.js';

// Test 1: Success on first attempt
console.log('Test 1: Success on first attempt');
try {
  const result = await retryWithBackoff(async () => {
    return 'success';
  });
  console.log('✓ Passed:', result === 'success');
} catch (error) {
  console.log('✗ Failed:', error.message);
}

// Test 2: Success after retries
console.log('\nTest 2: Success after retries');
let attemptCount = 0;
try {
  const result = await retryWithBackoff(async () => {
    attemptCount++;
    if (attemptCount < 3) {
      throw new Error(`Attempt ${attemptCount} failed`);
    }
    return 'success after retries';
  }, { maxRetries: 3, initialDelay: 100 });
  console.log('✓ Passed:', result === 'success after retries', `(attempts: ${attemptCount})`);
} catch (error) {
  console.log('✗ Failed:', error.message);
}

// Test 3: All retries fail
console.log('\nTest 3: All retries fail');
let failCount = 0;
try {
  await retryWithBackoff(async () => {
    failCount++;
    throw new Error(`Attempt ${failCount} failed`);
  }, { maxRetries: 2, initialDelay: 50 });
  console.log('✗ Failed: Should have thrown an error');
} catch (error) {
  console.log('✓ Passed:', error.message === 'Attempt 3 failed', `(attempts: ${failCount})`);
}

// Test 4: Input validation
console.log('\nTest 4: Input validation');
try {
  await retryWithBackoff('not a function');
  console.log('✗ Failed: Should have thrown TypeError');
} catch (error) {
  console.log('✓ Passed:', error instanceof TypeError);
}

console.log('\nAll tests completed');
