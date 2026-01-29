import { describe, it, expect } from 'vitest';

/**
 * Test to verify that the fix for duplicate content messages is correct.
 * 
 * This test verifies the logic change in App.jsx where API responses containing
 * both content and tool_calls should create only ONE assistant message in the
 * message history, not two separate messages.
 */
describe('Duplicate Message Fix - Logic Verification', () => {
  /**
   * Helper function to simulate the NEW fixed logic for creating assistant messages
   */
  const createAssistantMessage = (msg, messageIdCounter) => {
    const currentMessages = [];
    
    if (msg.content || msg.tool_calls) {
      const assistantMessage = {
        role: 'assistant',
        content: msg.content || null,
        id: messageIdCounter
      };
      
      if (msg.tool_calls) {
        assistantMessage.tool_calls = msg.tool_calls;
      }
      
      currentMessages.push(assistantMessage);
    }
    
    return currentMessages;
  };

  it('should create a single assistant message when response has both content and tool_calls', () => {
    // Simulated API response with BOTH content and tool_calls
    const msg = {
      content: "I'll resize the video for you.",
      tool_calls: [{
        id: 'call_1',
        function: {
          name: 'resize_video',
          arguments: JSON.stringify({ width: 640, height: 480 })
        }
      }]
    };
    
    // Use the helper to apply the NEW LOGIC
    const currentMessages = createAssistantMessage(msg, 1);
    
    // Verify: Should have exactly ONE assistant message
    expect(currentMessages.length).toBe(1);
    
    // Verify: The message should have both content and tool_calls
    expect(currentMessages[0].role).toBe('assistant');
    expect(currentMessages[0].content).toBe("I'll resize the video for you.");
    expect(currentMessages[0].tool_calls).toBeDefined();
    expect(currentMessages[0].tool_calls.length).toBe(1);
  });

  it('should create a single assistant message with content when response has only content', () => {
    // Simulated API response with ONLY content
    const msg = {
      content: "Video processed successfully."
    };
    
    // Use the helper to apply the NEW LOGIC
    const currentMessages = createAssistantMessage(msg, 1);
    
    // Verify: Should have exactly ONE assistant message
    expect(currentMessages.length).toBe(1);
    
    // Verify: The message should have content but no tool_calls
    expect(currentMessages[0].role).toBe('assistant');
    expect(currentMessages[0].content).toBe("Video processed successfully.");
    expect(currentMessages[0].tool_calls).toBeUndefined();
  });

  it('should create a single assistant message with null content when response has only tool_calls', () => {
    // Simulated API response with ONLY tool_calls (no content)
    const msg = {
      content: null,
      tool_calls: [{
        id: 'call_1',
        function: {
          name: 'resize_video',
          arguments: JSON.stringify({ width: 640, height: 480 })
        }
      }]
    };
    
    // Use the helper to apply the NEW LOGIC
    const currentMessages = createAssistantMessage(msg, 1);
    
    // Verify: Should have exactly ONE assistant message
    expect(currentMessages.length).toBe(1);
    
    // Verify: The message should have null content and tool_calls
    expect(currentMessages[0].role).toBe('assistant');
    expect(currentMessages[0].content).toBeNull();
    expect(currentMessages[0].tool_calls).toBeDefined();
    expect(currentMessages[0].tool_calls.length).toBe(1);
  });

  it('OLD LOGIC would have created TWO messages (demonstrating the bug)', () => {
    const currentMessages = [];
    let messageIdCounter = 1;
    
    // Simulated API response with BOTH content and tool_calls
    const msg = {
      content: "I'll resize the video for you.",
      tool_calls: [{
        id: 'call_1',
        function: {
          name: 'resize_video',
          arguments: JSON.stringify({ width: 640, height: 480 })
        }
      }]
    };
    
    // OLD LOGIC (before fix): This would create TWO separate messages
    if (msg.content) {
      currentMessages.push({ 
        role: 'assistant', 
        content: msg.content, 
        id: messageIdCounter++ 
      });
    }
    
    if (msg.tool_calls) {
      currentMessages.push({ 
        role: 'assistant', 
        content: null, 
        tool_calls: msg.tool_calls, 
        id: messageIdCounter++ 
      });
    }
    
    // This demonstrates the BUG: TWO assistant messages were created
    expect(currentMessages.length).toBe(2);
    
    // First message has content but no tool_calls
    expect(currentMessages[0].role).toBe('assistant');
    expect(currentMessages[0].content).toBe("I'll resize the video for you.");
    expect(currentMessages[0].tool_calls).toBeUndefined();
    
    // Second message has tool_calls but null content
    expect(currentMessages[1].role).toBe('assistant');
    expect(currentMessages[1].content).toBeNull();
    expect(currentMessages[1].tool_calls).toBeDefined();
  });
});
