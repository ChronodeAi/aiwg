import { ClaudeSessionAdapter } from './adapters/claude.js';
import { CodexSessionAdapter } from './adapters/codex.js';
import { CopilotSessionAdapter } from './adapters/copilot.js';
import { CursorSessionAdapter } from './adapters/cursor.js';
import { FactorySessionAdapter } from './adapters/factory.js';
import { HermesSessionAdapter } from './adapters/hermes.js';
import { OpenCodeSessionAdapter } from './adapters/opencode.js';
import { OpenClawSessionAdapter } from './adapters/openclaw.js';
import { OpenHumanSessionAdapter } from './adapters/openhuman.js';
import { GrokbotSessionAdapter } from './adapters/grokbot.js';
import { GrokBuildSessionAdapter } from './adapters/grok-build.js';
import { MuseSessionAdapter } from './adapters/muse.js';
import { PiSessionAdapter } from './adapters/pi.js';
import { OmpSessionAdapter } from './adapters/omp.js';
import { DeepSeekHarnessSessionAdapter } from './adapters/deepseek-harness.js';
import { WarpSessionAdapter } from './adapters/warp.js';
import { DevinDesktopSessionAdapter } from './adapters/windsurf.js';
import { GenericSessionInterchangeAdapter } from './adapters/generic.js';
import { SessionSourceAdapterRegistry } from './discovery.js';

export function createSessionAdapterRegistry(): SessionSourceAdapterRegistry {
  const registry = new SessionSourceAdapterRegistry();
  for (const adapter of [
    new ClaudeSessionAdapter(),
    new CodexSessionAdapter(),
    new CopilotSessionAdapter(),
    new CursorSessionAdapter(),
    new FactorySessionAdapter(),
    new HermesSessionAdapter(),
    new OpenCodeSessionAdapter(),
    new OpenClawSessionAdapter(),
    new OpenHumanSessionAdapter(),
    new GrokbotSessionAdapter(),
    new GrokBuildSessionAdapter(),
    new MuseSessionAdapter(),
    new PiSessionAdapter(),
    new OmpSessionAdapter(),
    new DeepSeekHarnessSessionAdapter(),
    new WarpSessionAdapter(),
    new DevinDesktopSessionAdapter(),
    new GenericSessionInterchangeAdapter(),
  ]) registry.register(adapter);
  return registry;
}
