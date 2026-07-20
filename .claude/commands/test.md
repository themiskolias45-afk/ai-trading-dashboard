Write and run tests for a function or feature. Usage: /test [what to test]

$ARGUMENTS is the function name, file, or feature to test.

Steps:

1. READ the code being tested — full file, understand every path
2. IDENTIFY test cases:
   - Happy path: normal valid input → expected output
   - Edge cases: empty, null, zero, negative, very large values
   - Error cases: bad input, network down, file missing
   - Boundary cases: exactly at the limit (e.g. confidence = 65, = 64, = 66)

3. WRITE the tests in a test file next to the source:
   - JS: use Node's built-in assert module (no external deps needed)
   - Python: use unittest (built-in)
   - Name each test what it proves: test_signal_fires_at_65_confidence_not_64

4. RUN the tests:
   - JS: node [testfile]
   - Python: python -m unittest [testfile]

5. REPORT:
   - Tests written: X
   - Tests passed: X
   - Tests failed: X (fix each one before reporting done)
   - Coverage: [what paths are tested]

Rules:
- Every test must pass before this command ends.
- If a test fails, fix the code (not the test) unless the test was wrong.
- Don't test implementation details — test behavior (what it does, not how).
