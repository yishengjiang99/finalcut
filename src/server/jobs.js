import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { TMP_DIR, APP_BASE_URL } from './config.js';
import {
  videoProcessLimiter,
  requireAuthenticatedUser,
  requireInferenceAccess,
  requireActiveSubscription,
  uploadSingle,
  getBaseUrlFromRequest,
  isValidSampleModeRequest,
} from './middleware.js';
import {
  processMediaToFile,
  OpValidationError,
  assertOperationSupported,
  buildVisualFilter,
  resolveImageOutputMeta,
  validateVideoOperation,
} from './ffmpegOps.js';
import { detectMediaType, MEDIA_TYPE_IMAGE, MEDIA_TYPE_VIDEO } from './mediaType.js';

/** @type {Map<string, object>} */
const jobs = new Map();

const JOBS_DIR = path.join(TMP_DIR, 'finalcut-jobs');

async function ensureJobsDir() {
  await fs.mkdir(JOBS_DIR, { recursive: true });
}

export function publicJob(job, baseUrl) {
  const body = {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error || undefined,
    operation: job.operation,
    // "image" for photos, "video" otherwise — lets clients pick an image vs player view.
    mediaType: job.mediaType || MEDIA_TYPE_VIDEO,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.status === 'succeeded' && job.resultContentType) {
    body.resultUrl = `${baseUrl}/api/jobs/${job.id}/result`;
    body.contentType = job.resultContentType;
  }
  return body;
}

function getJobBaseUrl(req, job) {
  if (job.baseUrl) return job.baseUrl;
  if (APP_BASE_URL) return APP_BASE_URL.replace(/\/+$/, '');
  return getBaseUrlFromRequest(req);
}

async function runProcessVideoJob(job) {
  job.status = 'running';
  job.progress = 0;
  job.updatedAt = new Date().toISOString();
  try {
    await ensureJobsDir();
    const outputPath = job.mediaType === MEDIA_TYPE_IMAGE
      ? path.join(JOBS_DIR, `${job.id}.out.${job.expectedOutputExt || 'img'}`)
      : path.join(JOBS_DIR, `${job.id}.out`);
    const { contentType, outputExt, mediaType } = await processMediaToFile({
      mediaType: job.mediaType,
      imageFormat: job.imageFormat,
      inputPath: job.inputPath,
      inputMime: job.inputMime,
      operation: job.operation,
      args: job.args,
      outputPath,
    });
    job.resultPath = outputPath;
    job.resultContentType = contentType;
    job.resultExt = outputExt;
    job.mediaType = mediaType || job.mediaType;
    job.status = 'succeeded';
    job.progress = 1;
    job.updatedAt = new Date().toISOString();
  } catch (err) {
    console.error(`Job ${job.id} failed:`, err);
    job.status = 'failed';
    job.error = err.message || 'Processing failed';
    job.updatedAt = new Date().toISOString();
  } finally {
    if (job.inputPath) {
      fs.unlink(job.inputPath).catch(() => {});
      job.inputPath = null;
    }
  }
}

const router = express.Router();

/**
 * Detect photo vs video for an uploaded file and validate the operation for it.
 * Throws OpValidationError (400) for unsupported/invalid ops.
 */
export async function classifyAndValidateUpload({ buffer, mimetype, filename, inputPath, operation, args, probe }) {
  const detected = await detectMediaType({ buffer, mimetype, filename, inputPath, probe });
  assertOperationSupported(operation, detected.mediaType);
  let expectedOutputExt = null;
  if (detected.mediaType === MEDIA_TYPE_IMAGE) {
    buildVisualFilter(operation, args, MEDIA_TYPE_IMAGE);
    expectedOutputExt = resolveImageOutputMeta(detected.imageFormat, operation, args).outputExt;
  } else {
    validateVideoOperation(operation, args);
  }
  return { ...detected, expectedOutputExt };
}

/**
 * Enqueue an async process-video job (multipart — mobile-friendly).
 * Accepts videos and photos (jpg/png/webp/heic). Sync POST /api/process-video is separate.
 *
 * POST /api/jobs/process-video
 * multipart fields: video (file — a video or a photo), operation (string), args (JSON string, optional)
 * → 202 { jobId, status: "queued", mediaType: "image"|"video", pollUrl }
 * → 400 { error } for unsupported operations (e.g. trim_video on a photo) or invalid args
 */
router.post(
  '/api/jobs/process-video',
  videoProcessLimiter,
  requireAuthenticatedUser,
  requireInferenceAccess,
  uploadSingle('video'),
  async (req, res) => {
    let inputPath = null;
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No video file provided (multipart field "video")' });
      }
      const operation = req.body?.operation;
      if (!operation || typeof operation !== 'string') {
        return res.status(400).json({ error: 'operation is required' });
      }

      let args = {};
      if (req.body?.args) {
        try {
          args = typeof req.body.args === 'string' ? JSON.parse(req.body.args) : req.body.args;
        } catch {
          return res.status(400).json({ error: 'args must be valid JSON' });
        }
      }

      if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};

      await ensureJobsDir();
      const id = randomUUID();
      inputPath = path.join(JOBS_DIR, `${id}.in`);
      await fs.writeFile(inputPath, req.file.buffer);

      const detected = await classifyAndValidateUpload({
        buffer: req.file.buffer,
        mimetype: req.file.mimetype,
        filename: req.file.originalname,
        inputPath,
        operation,
        args,
      });

      const baseUrl = getBaseUrlFromRequest(req);
      const job = {
        id,
        userId: req.user?.id ?? null,
        sampleMode: isValidSampleModeRequest(req),
        status: 'queued',
        progress: 0,
        error: null,
        operation,
        args,
        inputPath,
        inputMime: req.file.mimetype || 'video/mp4',
        mediaType: detected.mediaType,
        imageFormat: detected.imageFormat,
        expectedOutputExt: detected.expectedOutputExt,
        resultPath: null,
        resultContentType: null,
        baseUrl,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      jobs.set(id, job);
      inputPath = null; // owned by the job now

      setImmediate(() => {
        runProcessVideoJob(job).catch((err) => {
          console.error(`Unhandled job error ${id}:`, err);
          job.status = 'failed';
          job.error = err.message || 'Processing failed';
          job.updatedAt = new Date().toISOString();
        });
      });

      return res.status(202).json({
        jobId: id,
        status: 'queued',
        mediaType: job.mediaType,
        pollUrl: `${baseUrl}/api/jobs/${id}`,
      });
    } catch (error) {
      if (inputPath) fs.unlink(inputPath).catch(() => {});
      if (error instanceof OpValidationError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error('Error enqueueing process-video job:', error);
      return res.status(500).json({ error: 'Failed to enqueue job' });
    }
  }
);

/**
 * Poll job status (poll-only v1 — no SSE).
 * GET /api/jobs/:id → { jobId, status, progress?, error?, resultUrl? }
 * status: queued | running | succeeded | failed
 */
router.get(
  '/api/jobs/:id',
  videoProcessLimiter,
  requireAuthenticatedUser,
  requireActiveSubscription,
  async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    const sample = isValidSampleModeRequest(req);
    if (!sample && job.userId != null && req.user?.id != null && job.userId !== req.user.id) {
      return res.status(404).json({ error: 'Job not found' });
    }
    return res.json(publicJob(job, getJobBaseUrl(req, job)));
  }
);

/**
 * Download job result media (absolute resultUrl points here).
 */
router.get(
  '/api/jobs/:id/result',
  videoProcessLimiter,
  requireAuthenticatedUser,
  requireActiveSubscription,
  async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.status !== 'succeeded' || !job.resultPath) {
      return res.status(404).json({ error: 'Result not available' });
    }
    const sample = isValidSampleModeRequest(req);
    if (!sample && job.userId != null && req.user?.id != null && job.userId !== req.user.id) {
      return res.status(404).json({ error: 'Result not available' });
    }
    try {
      await fs.access(job.resultPath);
    } catch {
      return res.status(404).json({ error: 'Result file missing' });
    }
    res.set('Content-Type', job.resultContentType || 'application/octet-stream');
    res.set('X-Media-Type', job.mediaType || MEDIA_TYPE_VIDEO);
    if (job.resultExt) {
      res.set('Content-Disposition', `inline; filename="finalcap-${job.id}.${job.resultExt}"`);
    }
    return res.sendFile(path.resolve(job.resultPath), { headers: { 'Content-Type': job.resultContentType || 'application/octet-stream' } });
  }
);

export { router as jobsRouter, jobs as _jobsForTests };
