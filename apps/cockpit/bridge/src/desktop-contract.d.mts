export type DesktopMode = 'control' | 'observe';
export interface DesktopViewport { width: number; height: number; dpi: number }
export interface CreateDesktopRequest { requested_mode: DesktopMode; viewport: DesktopViewport }
export interface DesktopAttachmentRequest { mode: DesktopMode; viewport: DesktopViewport }
export interface DesktopCloseRequest { action: 'revoke_access' | 'sign_out' }
export interface DesktopPolicy {
  observe: boolean;
  control: boolean;
  sharing: boolean;
  clipboard_copy: boolean;
  clipboard_paste: boolean;
  file_transfer: boolean;
  audio: boolean;
  recording: boolean;
  isolation_tier: 'cooperative' | 'separate_desktop_vm';
  generation: number;
}
interface DesktopResource {
  schema_version: 'rdp-cockpit.v1';
  instance_id: string;
  incarnation: string;
  policy: DesktopPolicy;
}
export interface DesktopCapability extends DesktopResource {
  supported: boolean;
  readiness: 'ready' | 'not_ready' | 'unknown';
  reason_codes: string[];
}
export interface DesktopSession extends DesktopResource {
  id: string;
  workspace_id: string;
  state: 'preparing' | 'ready' | 'attached' | 'detached' | 'closing' | 'closed' | 'failed';
  cleanup: 'none' | 'pending' | 'complete' | 'failed';
  absolute_expires_at: string;
  retained_until: string | null;
}
export function isDesktopUuid(value: unknown): value is string;
export function validateDesktopRequest(kind: 'CreateDesktop', value: unknown): CreateDesktopRequest;
export function validateDesktopRequest(kind: 'AttachmentRequest', value: unknown): DesktopAttachmentRequest;
export function validateDesktopRequest(kind: 'CloseRequest', value: unknown): DesktopCloseRequest;
export function sanitizeDesktopResponse(kind: 'Capability', value: unknown): DesktopCapability;
export function sanitizeDesktopResponse(kind: 'Desktop', value: unknown): DesktopSession;
export function sanitizeDesktopResponse(kind: 'BackendAttachmentGrant', value: unknown): {
  attachment_id: string; desktop_id: string; grant: string; expires_at: string; policy_generation: number;
};
export function sanitizeDesktopProblem(value: unknown): { code: string; status: number; message: string };
