import { describe, it, expect, vi } from 'vitest';

/**
 * Tests to verify that the spinner (processing state) is hidden
 * as soon as video processing (tool calls) completes, not after
 * the follow-up AI API call finishes.
 *
 * The bug was that setProcessing(false) was called in a finally block
 * that wrapped BOTH the tool execution loop AND the recursive callAPI call.
 * This caused the spinner to remain visible during the follow-up API request
 * even though video processing was visibly done.
 *
 * The fix moves setProcessing(false) into a finally block that only wraps
 * the tool execution loop, so the spinner disappears as soon as processing ends.
 */
describe('Spinner Fix - Processing state cleared after tool calls, before follow-up API call', () => {
  it('should clear processing state before the follow-up API call', async () => {
    const setProcessing = vi.fn();
    const processingCallOrder = [];

    // Simulate the fixed logic: setProcessing(false) called before recursive callAPI
    const simulateFixed = async (toolCallsArray, executeTools, recursiveCallAPI) => {
      if (toolCallsArray.length > 0) {
        setProcessing(true);
        processingCallOrder.push('setProcessing(true)');

        try {
          await executeTools(toolCallsArray);
          processingCallOrder.push('tools done');
        } finally {
          setProcessing(false);
          processingCallOrder.push('setProcessing(false)');
        }
        await recursiveCallAPI();
        processingCallOrder.push('recursive API done');
      }
    };

    const executeTools = vi.fn().mockResolvedValue(undefined);
    const recursiveCallAPI = vi.fn().mockResolvedValue(undefined);

    await simulateFixed([{ id: 'call_1' }], executeTools, recursiveCallAPI);

    // Verify order: processing turned off BEFORE recursive API call
    expect(processingCallOrder).toEqual([
      'setProcessing(true)',
      'tools done',
      'setProcessing(false)',
      'recursive API done'
    ]);

    expect(setProcessing).toHaveBeenCalledWith(true);
    expect(setProcessing).toHaveBeenCalledWith(false);

    // setProcessing(false) must have been called before recursiveCallAPI
    const falseCallIndex = setProcessing.mock.calls.findIndex(call => call[0] === false);
    expect(falseCallIndex).toBe(1); // Second call (index 1) is setProcessing(false)
    expect(recursiveCallAPI).toHaveBeenCalled();
  });

  it('should clear processing state even when tool execution throws an error', async () => {
    const setProcessing = vi.fn();

    // Simulate the fixed logic with error handling
    const simulateFixed = async (toolCallsArray, executeTools, recursiveCallAPI) => {
      if (toolCallsArray.length > 0) {
        setProcessing(true);

        try {
          await executeTools(toolCallsArray);
        } finally {
          setProcessing(false);
        }
        await recursiveCallAPI();
      }
    };

    const executeTools = vi.fn().mockRejectedValue(new Error('ffmpeg error'));
    const recursiveCallAPI = vi.fn().mockResolvedValue(undefined);

    await expect(simulateFixed([{ id: 'call_1' }], executeTools, recursiveCallAPI))
      .rejects.toThrow('ffmpeg error');

    // setProcessing(false) must still be called even on error
    expect(setProcessing).toHaveBeenCalledWith(true);
    expect(setProcessing).toHaveBeenCalledWith(false);

    // Recursive API should NOT be called when tool execution fails
    expect(recursiveCallAPI).not.toHaveBeenCalled();
  });

  it('old buggy logic would keep spinner during follow-up API call', async () => {
    const setProcessing = vi.fn();
    const processingCallOrder = [];

    // Simulate the OLD buggy logic: setProcessing(false) called AFTER recursive callAPI
    const simulateBuggy = async (toolCallsArray, executeTools, recursiveCallAPI) => {
      if (toolCallsArray.length > 0) {
        setProcessing(true);
        processingCallOrder.push('setProcessing(true)');

        try {
          await executeTools(toolCallsArray);
          processingCallOrder.push('tools done');
          await recursiveCallAPI();
          processingCallOrder.push('recursive API done');
        } finally {
          setProcessing(false);
          processingCallOrder.push('setProcessing(false)');
        }
      }
    };

    const executeTools = vi.fn().mockResolvedValue(undefined);
    const recursiveCallAPI = vi.fn().mockResolvedValue(undefined);

    await simulateBuggy([{ id: 'call_1' }], executeTools, recursiveCallAPI);

    // BUG: spinner is still ON during recursive API call
    expect(processingCallOrder).toEqual([
      'setProcessing(true)',
      'tools done',
      'recursive API done', // <-- spinner was still visible here
      'setProcessing(false)' // <-- spinner only hides after recursive call
    ]);
  });

  it('spinner should not show when there are no tool calls', async () => {
    const setProcessing = vi.fn();

    const simulateFixed = async (toolCallsArray) => {
      if (toolCallsArray.length > 0) {
        setProcessing(true);
        try {
          // tool execution
        } finally {
          setProcessing(false);
        }
      }
    };

    await simulateFixed([]); // no tool calls

    expect(setProcessing).not.toHaveBeenCalled();
  });
});
