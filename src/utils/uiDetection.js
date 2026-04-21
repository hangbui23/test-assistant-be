/**
 * UI Detection utilities for determining if a JIRA issue is UI-related
 */

const BACKEND_KEYWORDS = [
  'API', 'endpoint', 'server', 'database', 'DB', 'SQL', 'query',
  'backend', 'back-end', 'microservice', 'service',
  'infrastructure', 'cloud', 'AWS', 'Azure', 'GCP',
  'cache', 'caching', 'memory', 'storage', 'S3', 'blob',
  'DevOps', 'CI/CD', 'pipeline', 'build', 'deploy',
  'authentication', 'authorization', 'security', 'encryption',
  'performance', 'optimization', 'throughput', 'latency',
  'ETL', 'data migration', 'data processing',
  'scheduler', 'cron', 'job', 'task', 'worker',
  'kafka', 'queue', 'message', 'event',
  'log', 'logging', 'monitor', 'monitoring',
  'config', 'configuration', 'environment', 'variable',
  'library', 'package', 'dependency', 'module'
];

const UI_KEYWORDS = [
  'UI', 'UX', 'user interface', 'user experience',
  'frontend', 'front-end', 'client-side', 'client side',
  'design', 'visual', 'layout', 'styling',
  'CSS', 'HTML', 'responsive', 'mobile',
  'component', 'widget', 'control',
  'button', 'form', 'input', 'dropdown', 'menu',
  'modal', 'dialog', 'popup', 'tooltip',
  'page', 'view', 'screen', 'viewport',
  'browser', 'display', 'show', 'render',
  'click', 'tap', 'hover', 'scroll', 'drag',
  'header', 'footer', 'navigation', 'sidebar',
  'theme', 'font', 'color', 'icon', 'image',
  'animation', 'transition', 'accessibility', 'a11y'
];

/**
 * Extract JIRA issue data for UI detection
 * @param {Object} issue - JIRA issue object
 * @param {Function} extractTextFromADF - Function to extract text from ADF format
 * @returns {Object} Extracted data with title, description, acceptanceCriteria
 */
export function extractJiraData(issue, extractTextFromADF = null) {
  let title = '';
  let description = '';
  let acceptanceCriteria = '';

  if (issue && issue.fields) {
    title = issue.fields.summary || '';

    // Handle description (can be object/ADF or string)
    if (issue.fields.description) {
      if (extractTextFromADF && typeof issue.fields.description === 'object') {
        description = extractTextFromADF(issue.fields.description) || '';
      } else if (typeof issue.fields.description === 'object' && issue.fields.description.content) {
        // ADF format - extract text manually
        description = issue.fields.description.content
          .map(c => c.content?.map(t => t.text).join(' '))
          .join('\n') || '';
      } else if (typeof issue.fields.description === 'string') {
        description = issue.fields.description;
      }
    }

    // Extract acceptance criteria from description
    if (description) {
      const acMatch = description.match(/acceptance criteria[:\s]*(.*?)(?=\n\n|\n[A-Z]|$)/is);
      if (acMatch) {
        acceptanceCriteria = acMatch[1].trim();
      }
    }
  }

  return {
    title,
    description,
    acceptanceCriteria
  };
}

/**
 * Check if a JIRA issue is UI-related using keyword analysis and optional OpenAI
 * @param {Object} issue - JIRA issue object
 * @param {Function} openaiCheckFn - Optional async function to call OpenAI for final check
 * @param {Function} extractTextFromADF - Optional function to extract text from ADF format
 * @returns {Promise<boolean>} True if UI-related
 */
export async function checkIfUiStory(issue, openaiCheckFn = null, extractTextFromADF = null) {
  // Extract issue data
  const issueData = extractJiraData(issue, extractTextFromADF);

  // Combine all text for keyword analysis
  const combinedText = `${issueData.title} ${issueData.description} ${issueData.acceptanceCriteria}`.toLowerCase();

  // Check for backend keywords
  const backendKeywords = BACKEND_KEYWORDS.filter(keyword => combinedText.includes(keyword.toLowerCase()));
  const backendKeywordCount = backendKeywords.length;

  // Check for UI keywords
  const uiKeywords = UI_KEYWORDS.filter(keyword => combinedText.includes(keyword.toLowerCase()));
  const uiKeywordCount = uiKeywords.length;

  // Quick decision: If we have strong UI indicators, return true immediately
  if (uiKeywordCount > 2) {
    return true;
  }

  // Quick decision: If there are many backend keywords and no UI indicators, likely not UI
  if (backendKeywordCount > 5 && uiKeywordCount === 0) {
    return false;
  }

  // Decision based on keyword comparison
  if (backendKeywordCount > uiKeywordCount) {
    return false;
  }

  // If we have an OpenAI check function, use it for final determination
  if (openaiCheckFn) {
    try {
      const context = `Title: ${issueData.title}\n\nDescription: ${issueData.description}\n\nAcceptance Criteria: ${issueData.acceptanceCriteria}`;
      const isUiStory = await openaiCheckFn(context);
      return isUiStory;
    } catch (error) {
      // Fallback to keyword-based decision if OpenAI fails
      return uiKeywordCount >= backendKeywordCount;
    }
  }

  // Final fallback: if UI keywords >= backend keywords, consider it UI
  return uiKeywordCount >= backendKeywordCount;
}

export { BACKEND_KEYWORDS, UI_KEYWORDS };