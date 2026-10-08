import { Router } from 'express';
import { providers } from '../providers/index.js';
import { DEFAULT_VOICE } from '../providers/edge.js';
import { DEFAULT_VOICE as KOKORO_DEFAULT_VOICE } from '../providers/kokoro.js';

export const voicesRouter = Router();

voicesRouter.get('/', async (req, res, next) => {
  try {
    const all = req.query.all === '1';
    const edgeVoices = await providers.edge.voices({ all });

    const elevenConfigured = providers.elevenlabs.available();
    let elevenVoices = [];
    let elevenError;
    if (elevenConfigured) {
      try {
        elevenVoices = await providers.elevenlabs.voices();
      } catch (err) {
        elevenError = err.message;
      }
    }

    const supertonicReady = providers.supertonic.available();
    const supertonicVoices = supertonicReady ? await providers.supertonic.voices() : [];

    const kokoroReady = providers.kokoro.available();
    const kokoroVoices = kokoroReady ? await providers.kokoro.voices() : [];

    res.json({
      edge: { voices: edgeVoices, default: DEFAULT_VOICE },
      elevenlabs: {
        available: elevenConfigured && !elevenError,
        voices: elevenVoices,
        ...(elevenError ? { error: elevenError } : {}),
      },
      supertonic: {
        available: supertonicReady && supertonicVoices.length > 0,
        voices: supertonicVoices,
        default: 'M1',
      },
      kokoro: {
        available: kokoroReady && kokoroVoices.length > 0,
        voices: kokoroVoices,
        default: KOKORO_DEFAULT_VOICE,
      },
    });
  } catch (err) {
    err.status ??= 502;
    next(err);
  }
});
