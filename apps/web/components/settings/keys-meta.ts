/**
 * The keys the Setup section asks for, grouped the way the owner gets them (one Google app, one
 * Meta app, Claude, speech-to-text, Telegram). Shared by the form and the server action.
 */
import type { UiKeyName } from '@app/core/env';

export interface KeyField {
  name: UiKeyName;
  label: string;
  /** Secrets use a password box and are never sent back to the browser. */
  secret: boolean;
  required: boolean;
  placeholder: string;
  hint?: string;
}

export type KeyGroupId = 'google' | 'meta' | 'claude' | 'stt' | 'telegram';

export interface KeyGroup {
  id: KeyGroupId;
  title: string;
  purpose: string;
  /** Optional groups never show "Needs setup". */
  optional?: boolean;
  fields: KeyField[];
}

export const KEY_GROUPS: KeyGroup[] = [
  {
    id: 'google',
    title: 'YouTube (Google app)',
    purpose: 'Lets the Connect YouTube button work.',
    fields: [
      {
        name: 'GOOGLE_CLIENT_ID',
        label: 'Client ID',
        secret: false,
        required: true,
        placeholder: '1234567890-abc….apps.googleusercontent.com',
      },
      {
        name: 'GOOGLE_CLIENT_SECRET',
        label: 'Client secret',
        secret: true,
        required: true,
        placeholder: 'GOCSPX-…',
      },
    ],
  },
  {
    id: 'meta',
    title: 'Facebook & Instagram (Meta app)',
    purpose: 'Lets the Connect Facebook & Instagram button work.',
    fields: [
      {
        name: 'META_APP_ID',
        label: 'App ID',
        secret: false,
        required: true,
        placeholder: '123456789012345',
      },
      {
        name: 'META_APP_SECRET',
        label: 'App secret',
        secret: true,
        required: true,
        placeholder: '32 letters and numbers',
      },
      {
        name: 'META_LOGIN_CONFIG_ID',
        label: 'Configuration ID',
        secret: false,
        required: true,
        placeholder: '987654321098765',
        hint: 'From Facebook Login for Business → Configurations.',
      },
    ],
  },
  {
    id: 'claude',
    title: 'Captions (Claude)',
    purpose: 'Writes your captions and titles. Until then you get sample text.',
    fields: [
      {
        name: 'ANTHROPIC_API_KEY',
        label: 'Claude API key',
        secret: true,
        required: true,
        placeholder: 'sk-ant-…',
      },
      {
        name: 'ANTHROPIC_WORKSPACE_ID',
        label: 'Workspace ID (only if asked)',
        secret: false,
        required: false,
        placeholder: 'wrkspc_…',
        hint: 'Leave empty unless captions fail with a message about a workspace.',
      },
    ],
  },
  {
    id: 'stt',
    title: 'Speech to text (Deepgram)',
    purpose: 'Listens to your Hindi + English speech so captions match what you say.',
    fields: [
      {
        name: 'DEEPGRAM_API_KEY',
        label: 'Deepgram API key',
        secret: true,
        required: true,
        placeholder: 'Paste the key',
      },
      {
        name: 'OPENAI_API_KEY',
        label: 'OpenAI key (other provider, optional)',
        secret: true,
        required: false,
        placeholder: 'sk-…',
      },
      {
        name: 'SARVAM_API_KEY',
        label: 'Sarvam AI key (other provider, optional)',
        secret: true,
        required: false,
        placeholder: 'Paste the key',
      },
      {
        name: 'ASSEMBLYAI_API_KEY',
        label: 'AssemblyAI key (other provider, optional)',
        secret: true,
        required: false,
        placeholder: 'Paste the key',
      },
    ],
  },
  {
    id: 'telegram',
    title: 'Alerts on Telegram',
    purpose: 'Tells you on your phone when a post fails or needs you.',
    optional: true,
    fields: [
      {
        name: 'TELEGRAM_BOT_TOKEN',
        label: 'Bot token',
        secret: true,
        required: true,
        placeholder: '123456789:AA…',
      },
    ],
  },
];

export const KEY_FIELDS: Record<UiKeyName, KeyField> = Object.fromEntries(
  KEY_GROUPS.flatMap((g) => g.fields.map((f) => [f.name, f])),
) as Record<UiKeyName, KeyField>;
