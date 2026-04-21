import mongoose from "mongoose";

/*
* SUB-SCHEMAS
*/

//Mark down schema
const markdownSchema = new mongoose.Schema({
  content: { type: String },
  file: { type: String },
}, { _id: false });

//Jira ticket schema
const jiraSchema = new mongoose.Schema({
  issueUrl: { type: String },
  issueType: { type: String },
  createdAt: { type: Date },
}, { _id: false });

//PDF attachment schema
const pdfAttachmentSchema = new mongoose.Schema({
  attachmentId: { type: String },
  filename: { type: String },
  attachedAt: { type: Date },
  commentId: { type: String },
}, { _id: false });

//Version schema
const versionSchema = new mongoose.Schema({
  version: { type: Number, requireqd: true },
  content: { type: String, requireqd: true },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: String, required: true },
  notes: { type: String },
}, { _id: false });

/*
MAIN SCHEMA - GENERATION SCHEMA
*/
const generationSchema = new mongoose.Schema({
  issueKey: { type: String, index: true },
  email: { type: String, index: true },
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true
  },
  mode: { type: String, enum: ['Manual', 'Auto'] },
  status: { type: String, enum: ['Running','Completed', 'Failed'] },
  createdAt: { type: Date, default: Date.now },
  startedAt: { type: Date },
  completedAt: { type: Date },
  generationTimeSeconds: { type: Number },
  cost: { type: Number },
  tokensUsage: {
    promptTokens: Number,
    completionTokens: Number,
    totalTokens: Number
  },
  results: {
    markdown: { type: markdownSchema }
  },
  jiraTickets: [jiraSchema],
  pdfAttachments: [pdfAttachmentSchema],
  versions: [versionSchema],
  error: { type: String },
  published: { type: Boolean, default: false, index: true },
  publishedAt: { type: Date },
  publishedBy: { type: String },
  currentVersion: { type: Number, default: 1 }

}, { timestamps: true });


export default mongoose.model('Generation', generationSchema);