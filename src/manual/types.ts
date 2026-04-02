// src/manual/types.ts

export type VideoMode = 'reels' | 'video';
export type JobStatus =
  | 'pending' | 'fetching' | 'scripting' | 'tts'
  | 'encoding' | 'uploading' | 'done' | 'failed';

export interface ManualJobRequest {
  author: string;       // DB author field, VD: 'giavang24'
  mode: VideoMode;
  customImagePaths: string[];  // uploaded files
  customImageUrls: string[];   // remote URLs
  postToFacebook: boolean;
  facebookDescription?: string;
}

export interface ManualJob {
  id: string;
  request: ManualJobRequest;
  status: JobStatus;
  progress: number;
  currentStep: string;
  logs: JobLogEntry[];
  contentPreview?: string;  // snippet of DB content shown in UI
  script?: string;
  videoPath?: string;
  facebookPostId?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobLogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

export interface JobUpdateEvent {
  jobId: string;
  status: JobStatus;
  progress: number;
  step: string;
  log?: JobLogEntry;
  result?: {
    script?: string;
    facebookPostId?: string;
    error?: string;
  };
}
