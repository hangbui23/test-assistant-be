import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import JiraService from '../services/jiraServices.js';
import OpenAIService from '../services/openaiService.js';
import { logger } from '../utils/logger.js';
import { checkIfUiStory } from '../utils/uiDetection.js';
import Generation from '../models/Generation.js';
import { extractProject,findOrCreateProject } from '../utils/projectUtils.js';

const router = Router();

// Lazy initialize JIRA service
let jiraService = null;
export function getJiraService() {
  if (!jiraService) {
    try {
      jiraService = new JiraService();
    } catch (error) {
      throw new Error('JIRA service not configured. Please set JIRA_EMAIL and JIRA_API_TOKEN in .env');
    }
  }
  return jiraService;
}

// Lazy initialize OpenAI service
let openaiService = null;
function getOpenAIService() {
  if (!openaiService) {
    try {
      openaiService = new OpenAIService();
    } catch (error) {
      throw new Error('OpenAI service not configured. Please set OPENAI_API_KEY in .env');
    }
  }
  return openaiService;
}

// Get all generations (user's own + published ones) with pagination
router.get('/', requireAuth, async (req, res, next) => {
  try {
    // Parse pagination parameters
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)));
    const skip = (page - 1) * limit;
    const filterType = req.query.filter; // 'mine', 'published', or undefined for 'all'
    const project = req.query.project; // project filter

    // Build filter object based on filterType
    let filter = {};

    if (filterType === 'mine') {
      // Only user's own generations
      filter.email = req.user.email;
    } else if (filterType === 'published') {
      // Only published generations
      filter.published = true;
    } else {
      // Default 'all': show ALL records (frontend will control View link visibility)
      filter = {}; // No filter
    }

    // Add project filter if specified
    if (project && project !== 'all') {
      filter.project = project;
    }

    // Fetch generations with pagination
    const [generations, total] = await Promise.all([
      Generation.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Generation.countDocuments(filter)
    ]);

    // Calculate total pages
    const pages = Math.ceil(total / limit);

    return res.json({ 
      success: true, 
      data: { 
        generations,
        pagination: {
          page,
          limit,
          total,
          pages
        }
      } 
    });
  } catch (e) { 
    next(e); 
  }
});


// Preflight check endpoint
router.post('/preflight', requireAuth, async (req, res, next) => {
  console.log('[GENERATIONS] /preflight request received');
  try {
    const { issueKey } = req.body;
    if (!issueKey) {
      return res.status(400).json({ success: false, error: 'issueKey required' });
    }
    
    // Fetch issue from JIRA
    const jira = getJiraService();
    const issueResult = await jira.getIssue(issueKey);
    if (!issueResult.success) {
      // Return appropriate status code based on error type
      const statusCode = issueResult.error.includes('authentication') || issueResult.error.includes('forbidden') 
        ? 401 
        : issueResult.error.includes('not found') 
        ? 404 
        : 500;
      return res.status(statusCode).json({ success: false, error: issueResult.error || 'Issue not found in JIRA' });
    }

    const issue = issueResult.issue;
    const fields = issue.fields;
    const summary = fields.summary || '';
    const description = jira.extractTextFromADF(fields.description) || '';
    
    // Count attachments
    const attachments = fields.attachment || [];
    const imageAttachments = attachments.filter(att => att.mimeType?.startsWith('image/'));
    
    // UI detection: use improved keyword analysis + OpenAI
    const openai = getOpenAIService();
    const openaiCheckFn = async (context) => {
      return await openai.checkIfUiStory(context);
    };
    
    const isUiStory = await checkIfUiStory(issue, openaiCheckFn, jira.extractTextFromADF.bind(jira));
    logger.info(`UI detection for ${issueKey}: ${isUiStory ? 'UI story' : 'Not UI story'}`);
    
    // Estimate tokens (rough approximation: 1 token ≈ 4 characters)
    const contextText = `${summary} ${description}`;
    const contextLength = contextText.length;
    const estimatedTokens = Math.ceil(contextLength / 4) + (imageAttachments.length * 200); // ~200 tokens per image
    
    // Estimate cost (gpt-4o-mini pricing: $0.15/1M input tokens, $0.60/1M output tokens)
    const estimatedCost = (estimatedTokens / 1000000) * 0.15 + (8000 / 1000000) * 0.60; // Assume ~8k output tokens
    
    // Check for existing generations with the same issueKey (case-insensitive)
    const normalizedIssueKey = issueKey.trim();
    const issueKeyRegex = new RegExp(`^${normalizedIssueKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    
    // First, check for published generations (visible to all users)
    const existingPublished = await Generation.findOne({
      issueKey: issueKeyRegex,
      published: true,
      status: 'Completed'
    }).sort({ createdAt: -1 }); // Get the most recent one
    
    // Also check for user's own generations (even if not published)
    const existingUserGeneration = await Generation.findOne({
      issueKey: issueKeyRegex,
      email: req.user.email,
      status: 'Completed'
    }).sort({ createdAt: -1 }); // Get the most recent one
    
    let existingPublishedGeneration = null;
    if (existingPublished) {
      // Get the latest version update time if available
      const latestVersion = existingPublished.versions && existingPublished.versions.length > 0
        ? existingPublished.versions[existingPublished.versions.length - 1]
        : null;
      
      existingPublishedGeneration = {
        id: String(existingPublished._id),
        createdAt: existingPublished.createdAt,
        updatedAt: latestVersion?.updatedAt || existingPublished.updatedAt || existingPublished.createdAt,
        publishedAt: existingPublished.publishedAt,
        publishedBy: existingPublished.publishedBy,
        currentVersion: existingPublished.currentVersion || 1
      };
    }
    
    let existingUserOwnGeneration = null;
    if (existingUserGeneration) {
      // Don't duplicate if it's the same as published generation
      if (!existingPublished || String(existingUserGeneration._id) !== String(existingPublished._id)) {
        // Get the latest version update time if available
        const latestVersion = existingUserGeneration.versions && existingUserGeneration.versions.length > 0
          ? existingUserGeneration.versions[existingUserGeneration.versions.length - 1]
          : null;
        
        existingUserOwnGeneration = {
          id: String(existingUserGeneration._id),
          createdAt: existingUserGeneration.createdAt,
          updatedAt: latestVersion?.updatedAt || existingUserGeneration.updatedAt || existingUserGeneration.createdAt,
          publishedAt: existingUserGeneration.publishedAt || null,
          publishedBy: existingUserGeneration.publishedBy || null,
          currentVersion: existingUserGeneration.currentVersion || 1,
          isPublished: existingUserGeneration.published || false
        };
      }
    }

    return res.json({ success: true, data: {
      isUiStory,
      issueKey,
      title: fields.summary || 'N/A',
      description: jira.extractTextFromADF(fields.description) || '',
      attachments: attachments.length,
      imageAttachments: imageAttachments.length,
      estimatedTokens,
      estimatedCost: estimatedCost.toFixed(6),
      existingPublishedGeneration: existingPublishedGeneration,
      existingUserOwnGeneration: existingUserOwnGeneration
    }});
  } catch (e) { 
    next(e); 
  }
});

router.post('/testcases', requireAuth, async (req, res, next) => {
  try {
    const { issueKey, async: isAsync = false, autoMode = false } = req.body || {};
    if (!issueKey) {
      return res.status(400).json({ success: false, error: 'issueKey required' });
    }

    // Extract project key and find/create project
    const projectKey = extractProject(issueKey);
    let project = null;
    
    if (projectKey) {
      try {
        project = await findOrCreateProject(projectKey, req.user.email);
        logger.info(`Associated generation with project: ${projectKey}`);
      } catch (projectError) {
        logger.warn(`Failed to find/create project ${projectKey}: ${projectError.message}. Continuing without project.`);
      }
    }

    // Add this check before creating the Generation
    if (!project) {
      return res.status(400).json({ success: false, error: 'Project not found for this issueKey.' });
    }

    // Create generation document
    const generation = new Generation({
      issueKey,
      email: req.user.email,
      project: project ? project._id : undefined,
      mode: autoMode ? 'Auto' : 'Manual',
      status: isAsync ? 'queued' : 'Running',
      startedAt: isAsync ? undefined : new Date()
    });
    await generation.save();
    
    // Update project stats
    if (project) {
      const Project = (await import('../models/Project.js')).default;
      const updatedProject = await Project.findById(project._id);
      if (updatedProject) {
        updatedProject.totalGenerations = await Generation.countDocuments({ project: project._id });
        await updatedProject.save();
      }
    }

    // Handle async mode
    if (isAsync) {
      return res.json({ 
        success: true, 
        data: { 
          generationId: String(generation._id), 
          status: 'queued' 
        } 
      });
    }

    // Sync: Fetch JIRA data and generate
    const startTime = Date.now();
    
    // Fetch issue from JIRA
    const jira = getJiraService();
    const issueResult = await jira.getIssue(issueKey);

    if (!issueResult.success) {
      generation.status = 'Failed';
      generation.error = issueResult.error || 'Failed to fetch JIRA issue';
      generation.completedAt = new Date();
      await generation.save();
      return res.status(404).json({ success: false, error: issueResult.error });
    }

    const issue = issueResult.issue;
    const fields = issue.fields;
    
    // Build context from JIRA issue data
    const summary = fields.summary || '';
    const description = jira.extractTextFromADF(fields.description) || '';
    
    // Extract acceptance criteria
    let acceptanceCriteria = '';
    if (fields.customfield_10026) {
      acceptanceCriteria = jira.extractTextFromADF(fields.customfield_10026) || '';
    } else if (fields.customfield_10016) {
      acceptanceCriteria = jira.extractTextFromADF(fields.customfield_10016) || '';
    }
    
    // Build context string
    const context = `Title: ${summary} Description:${description} ${acceptanceCriteria ? `Acceptance Criteria:\n${acceptanceCriteria}` : ''}`;
    
    // Generate test cases using OpenAI
    let markdownContent;
    let tokenUsage = null;
    let cost = null;
    
    try {
      const openai = getOpenAIService();
      const openaiImages = [];
      
      logger.info(`Generating test cases with OpenAI (mode: ${autoMode ? 'Auto' : 'Manual'})`);
      const result = await openai.generateTestCases(context, issueKey, autoMode, openaiImages);
      
      // Handle response format
      if (typeof result === 'string') {
        markdownContent = result;
      } else {
        markdownContent = result.content;
        tokenUsage = result.tokenUsage;
        cost = result.cost;
      }
      
      // Ensure we have a proper title
      if (!markdownContent.startsWith('#')) {
        markdownContent = `# Test Cases for ${issueKey}: ${summary || 'Untitled'}\n\n${markdownContent}`;
      }
    } catch (error) {
      logger.error(`OpenAI generation failed: ${error.message}`);
      generation.status = 'Failed';
      generation.error = `OpenAI generation failed: ${error.message}`;
      generation.completedAt = new Date();
      await generation.save();
      return res.status(500).json({ success: false, error: error.message || 'Failed to generate test cases' });
    }

    // Calculate generation time
    const generationTimeSeconds = (Date.now() - startTime) / 1000;

    // Only mark as completed if markdownContent is not empty
    if (!markdownContent || markdownContent.trim() === '') {
      logger.error('OpenAI returned empty markdown content');
      generation.status = 'Failed';
      generation.error = 'OpenAI returned empty markdown content';
      generation.completedAt = new Date();
      await generation.save();
      return res.status(500).json({ success: false, error: 'Failed to generate test cases: empty content' });
    }

    logger.info('Saving generation with markdown content:', markdownContent);
    generation.status = 'Completed';
    generation.completedAt = new Date();
    generation.generationTimeSeconds = Math.round(generationTimeSeconds * 100) / 100;
    generation.cost = cost;
    generation.tokenUsage = tokenUsage;
    generation.results = {
      markdown: {
        file: `${issueKey}_testcases_${generation._id}.md`,
        content: markdownContent
      }
    };
    generation.currentVersion = 1;
    generation.versions = [];
    
    await generation.save();

   logger.info({
     success: true, 
      data: {
        generationId: String(generation._id),
        issueKey,
        markdown: generation.results?.markdown,
        generationTimeSeconds: generation.generationTimeSeconds,
        cost: generation.cost
      }
   });

    // Return success response
    return res.json({ 
      success: true, 
      data: {
        generationId: String(generation._id),
        issueKey,
        markdown: generation.results?.markdown,
        generationTimeSeconds: generation.generationTimeSeconds,
        cost: generation.cost
      }
    });
  } catch (e) { 
    next(e); 
  }
});

// View (content stored in MongoDB) - allow viewing if it's user's own or published
router.get('/:id/view', requireAuth, async (req, res, next) => {
  try {
    const generation = await Generation.findById(req.params.id);
    if (!generation) {
      return res.status(404).json({ success: false, error: 'Generation not found' });
    }
    // Check if user has permission to view
    // Allow if it's user's own OR if it's published and completed
    const isOwner = generation.email === req.user.email;
    const isPublishedAndCompleted = generation.published && generation.status === 'Completed';
    
    if (!isOwner && !isPublishedAndCompleted) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    if (generation.status !== 'Completed') {
      return res.status(400).json({ success: false, error: 'Generation not completed yet' });
    }
    // Get latest version info
    const latestVersion = generation.versions && generation.versions.length > 0 
      ? generation.versions[generation.versions.length - 1]
      : null;
     // Extract project key from issue key (e.g., "KAN-123" -> "KAN")
    const projectKey = generation.issueKey ? extractProject(generation.issueKey) : null;

    res.set('Cache-Control', 'no-store');
    return res.json({ 
      success: true, 
      data: {
        email: generation.email, 
        content: generation.results?.markdown?.content || '', 
        filename: generation.results?.markdown?.filename || 'output.md', 
        format: 'markdown',
        // Metadata for header
        issueKey: generation.issueKey,
        projectKey: projectKey,
        updatedAt: generation.updatedAt,
        published: generation.published || false,
        publishedAt: generation.publishedAt,
        publishedBy: generation.publishedBy,
        currentVersion: generation.currentVersion || 1,
        versions: generation.versions || [],
        lastUpdatedBy: latestVersion?.updatedBy || generation.email,
        lastUpdatedAt: latestVersion?.updatedAt || generation.updatedAt || generation.createdAt
      } 
    });
  } catch (e) {
     next(e); 
  }
});

// Update generation content (only owner can update)
router.put('/:id/content', requireAuth, async (req, res, next) => {
try {
    const { content } = req.body;
    if (typeof content !== 'string') {
      return res.status(400).json({ success: false, error: 'content must be a string' });
    }

    const gen = await Generation.findById(req.params.id);
    if (!gen || gen.email !== req.user.email) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    
    if (gen.status !== 'Completed') {
      return res.status(400).json({ success: false, error: 'Can only update completed generations' });
    }

    // Track version: always save current content as a version before updating
    const currentContent = gen.results?.markdown?.content || '';
    if (!gen.versions) gen.versions = [];
    const currentVersionNum = gen.currentVersion || 1;
    // Save the current content as a version (only if we haven't already saved this version)
    if (currentContent) {
      const versionExists = gen.versions.some(v => v.version === currentVersionNum);
      if (!versionExists) {
        gen.versions.push({
          version: currentVersionNum,
          content: currentContent,
          updatedAt: new Date(),
          updatedBy: req.user.email
        });
        logger.info(`Saved version ${currentVersionNum} to versions array for generation ${req.params.id}`);
      }
    }
    // Increment version for the new content
    gen.currentVersion = currentVersionNum + 1;
    logger.info(`Updating generation ${req.params.id} to version ${gen.currentVersion}`);

    // Update the markdown content
    if (!gen.results) gen.results = {};
    if (!gen.results.markdown) gen.results.markdown = {};
    gen.results.markdown.content = content;

    // Log before saving
    logger.info(`[PUT /generations/${req.params.id}/content] Saving content for generation. New content length: ${content.length}`);
    await gen.save();
    logger.info(`[PUT /generations/${req.params.id}/content] Saved successfully. Current version: ${gen.currentVersion}`);

    return res.json({ 
      success: true, 
      data: { 
        content: gen.results.markdown.content,
        currentVersion: gen.currentVersion || 1
      } 
    });
  } catch (e) { 
    next(e); 
  }  
});

// Publish/Unpublish generation
router.put('/:id/publish', requireAuth, async (req, res, next) => {
  try {
    const { published } = req.body;
    if (typeof published !== 'boolean') {
      return res.status(400).json({ success: false, error: 'published must be a boolean' });
    }

    const gen = await Generation.findById(req.params.id);
    if (!gen || gen.email !== req.user.email) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    
    if (gen.status !== 'Completed') {
      return res.status(400).json({ success: false, error: 'Can only publish completed generations' });
    }

    gen.published = published;
    if (published) {
      gen.publishedAt = new Date();
      gen.publishedBy = req.user.email;
      logger.info(`Generation ${req.params.id} published by ${req.user.email}`);
    } else {
      gen.publishedAt = undefined;
      gen.publishedBy = undefined;
      logger.info(`Generation ${req.params.id} unpublished by ${req.user.email}`);
    }
    
    await gen.save();

    return res.json({ 
      success: true, 
      data: { 
        published: gen.published,
        publishedAt: gen.publishedAt,
        publishedBy: gen.publishedBy
      } 
    });
  } catch (e) { 
    next(e); 
  }
});

router.get('/:id/download', requireAuth, async (req, res, next) => {
  try {
    const gen = await Generation.findById(req.params.id);
    if (!gen) return res.status(404).json({ success: false, error: 'Not found' });
    
    // Check if user has permission to download
    // Allow if it's user's own OR if it's published and completed
    const isOwner = gen.email === req.user.email;
    const isPublishedAndCompleted = gen.published && gen.status === 'completed';
    
    if (!isOwner && !isPublishedAndCompleted) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    
    if (gen.status !== 'Completed') {
      return res.status(400).json({ success: false, error: 'Not completed' });
    }
    
    // Set headers for file download
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${gen.results?.markdown?.filename || 'output.md'}"`);
    
    // Send the markdown content
    return res.send(gen.results?.markdown?.content || '');
  } catch (e) { 
    next(e); 
  }
});

// Delete generation (only owner can delete)
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const gen = await Generation.findById(req.params.id);
    if (!gen) {
      return res.status(404).json({ success: false, error: 'Generation not found' });
    }
    
    // Only the owner can delete their generation
    if (gen.email !== req.user.email) {
      return res.status(403).json({ success: false, error: 'You can only delete your own generations' });
    }
    
    // Check if it's published - warn but allow deletion
    if (gen.published) {
      logger.warn(`User ${req.user.email} is deleting published generation ${req.params.id}`);
    }
    
    // Delete the generation
    await Generation.findByIdAndDelete(req.params.id);
    
    logger.info(`Generation ${req.params.id} deleted by ${req.user.email}`);
    return res.json({ success: true, message: 'Generation deleted successfully' });
  } catch (e) { 
    next(e); 
  }
});


export default router;