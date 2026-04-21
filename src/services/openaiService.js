import OpenAI from 'openai';
import { logger } from '../utils/logger.js';
import dotenv from 'dotenv';
dotenv.config();

const MANUAL_PROMPT = `You are an expert manual QA Engineer. Generate comprehensive manual test cases from JIRA issue descriptions.

Context:
You will receive JIRA issue details including title, description, comments, and acceptance criteria.
Use ONLY the provided information. Never invent requirements.

Output Requirements:

1. Use proper Markdown formatting.
2. Include a title exactly in this format:
# Test Cases for [JIRA-ID]: [Issue Title]

3. Organize test cases under these sections when applicable:
## Functional Requirements
## UI & Visual Validation
## Edge Cases
## Data Integrity

4. Each test case MUST follow this exact structure:

### Test Case X: <Title>

Priority: High | Medium | Low

Preconditions: <condition>

Steps:
1. Step one
2. Step two
3. Step three

Expected Result:
<expected outcome>

Formatting Rules:

- Steps MUST be a numbered list (1., 2., 3.).
- Do NOT place Steps inside bullet lists.
- Do NOT use bullet points for steps.
- Leave a blank line between sections.
- Always include the "### Test Case X" heading before each test case.
- Always insert a blank line after "Steps:" before the numbered list.

Each test case must:
- Be clear and actionable
- Cover acceptance criteria from the issue
- Include Preconditions, Steps, and Expected Result
- Include a Priority (High / Medium / Low)

Must NOT:
- Mention specific individual names
- Include implementation details (HTML classes, functions, code)
- Invent requirements not present in the JIRA issue

Coverage should include when applicable:
- Positive scenarios
- Negative scenarios
- Edge cases and boundary conditions
- Error handling
- User workflows
- Form validations
- State transitions
- Accessibility considerations for UI elements

Generate the test cases now.`;


const AUTO_PROMPT = `You are an expert QA automation specialist. Generate automation-friendly test cases from JIRA issue descriptions.

**Context:** You will receive JIRA issue details. Use ONLY this information - never invent requirements.

**Output Requirements:**
1. Use proper markdown format
2. Title: "# Automation Tests for [JIRA-ID]: [Issue Title]"
3. Structure tests by acceptance criteria
4. Include blank lines before and after lists
5. Each test should specify:
   - Clear, automatable steps
   - Specific UI elements or data to verify
   - Assertion points
   - Test data requirements

**Must NOT:**
- Never include subjective validations
- Never write vague steps
- Never include non-verifiable assertions

**Focus on:**
- Idempotent, independent test scenarios
- Clear element identification strategies
- Repeatable test data
- Programmatically verifiable assertions
- Error handling in automation
- State management

Generate automation-friendly test cases now.`;

class OpenAIService {
  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not configured in .env');
    }

    this.client = new OpenAI({ apiKey });
    this.model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this.max_completion_tokens = Number(process.env.OPENAI_MAX_COMPLETION_TOKENS || 8000);
    this.maxRetries = 3;
  }

  async checkIfUiStory(context) {
    try {
      const prompt = `Analyze the following JIRA issue description and determine if it's a UI-related story.

Issue Context:
${context}

Respond with ONLY a JSON object: {"ui": true} or {"ui": false}
Base your decision on whether the issue involves:
- User interface elements (buttons, forms, pages, screens)
- Visual design changes
- Frontend functionality
- User interaction flows
- UI/UX improvements

Respond in JSON format only.`;

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: 50,
        temperature: 0.3
      });

      const result = response.choices[0]?.message?.content?.trim();
      logger.info('OpenAI generateTestCases result:', result);
      try {
        const parsed = JSON.parse(result);
        return parsed.ui === true;
      } catch {
        // Fallback: check for "true" in response
        return result.toLowerCase().includes('"ui":true') || result.toLowerCase().includes('"ui": true');
      }
    } catch (error) {
      logger.error(`OpenAI UI check failed: ${error.message}`);
      return false; // Default to false on error
    }
  }

  async generateTestCases(context, issueKey, autoMode = false, images = []) {
    const systemPrompt = autoMode ? AUTO_PROMPT : MANUAL_PROMPT;
    //Build user message content
    const issueContext = `\n\n JIRA Issue Issue: ${issueKey}\n\nContext: ${context}`;
    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    // Create user message with text and images
    let userMessage;
    if (images && images.length > 0) {
      // Multimodal: text + images
      userMessage = {
        role: 'user',
        content: [
          { type: 'text', text: issueContext },
          ...images.map(img => ({
            type: 'image_url',
            image_url: { url: img }
          }))
        ]
      };
      logger.info(`Including ${images.length} images in OpenAI request`);
    } else {
      // Text-only
      userMessage = {
        role: 'user',
        content: issueContext
      };
    }
    messages.push(userMessage);

    // Retry logic
    let retryCount = 0;
    let lastError;

    while (retryCount <= this.maxRetries) {
      try {
        logger.info(`Calling OpenAI API (attempt ${retryCount + 1}/${this.maxRetries + 1})`);

        const response = await this.client.chat.completions.create({
          model: this.model,
          messages,
          max_completion_tokens: this.maxCompletionTokens,
          temperature: 0.7
        });

        const content = response.choices[0]?.message?.content;
        // Calculate cost (gpt-4o-mini pricing: $0.15/1M input, $0.60/1M output)

        // Calculate cost based on model pricing
        const usage = response.usage || {};
        const tokenUsage = {
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0
        };
        const inputCost = (tokenUsage.promptTokens / 1000000) * 0.15;
        const outputCost = (tokenUsage.completionTokens / 1000000) * 0.60;
        const totalCost = inputCost + outputCost;
        if (!content) {
          throw new Error('Empty response from OpenAI');
        }

        // Success - return result
        return { content, tokenUsage, cost: totalCost };

      } catch (error) {
        lastError = error;
        retryCount++;

        if (retryCount <= this.maxRetries) {
          const waitTime = Math.pow(2, retryCount) * 1000; // Exponential backoff
          logger.warn(`OpenAI API error (attempt ${retryCount}): ${error.message}. Retrying in ${waitTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        } else {
          logger.error(`OpenAI API failed after ${this.maxRetries + 1} attempts: ${error.message}`);
          throw error;
        }
      }
    }
  }
}

export default OpenAIService;