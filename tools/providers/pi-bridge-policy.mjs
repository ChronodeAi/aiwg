// Anchor the Pi bridge's policy loader to the installed AIWG package.
import { importImpl } from '../_resolve-impl.mjs';

export const { loadHitlLayers } = await importImpl(import.meta.url, 'policy/hitl-config.js');
