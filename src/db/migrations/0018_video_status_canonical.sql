-- ALO-138: canonicalise the video lifecycle status column.
--
-- Spec: uploading -> queued -> encoding -> ready / failed.
--
-- The runtime previously emitted a wider set of values from a few code
-- paths (videos.ts insert, encoding.ts queue handler, stream-webhook
-- callback). Map the legacy values onto the canonical set in one shot
-- so the state-machine helper has one alphabet to validate against.

UPDATE videos SET status = 'queued'    WHERE status IN ('uploaded', 'pending_encode', 'stream_submitted');
UPDATE videos SET status = 'failed'    WHERE status = 'encode_failed';
