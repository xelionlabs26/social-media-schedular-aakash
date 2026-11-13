export const metadata = { title: 'Privacy Policy' };

export default function PrivacyPage() {
  return (
    <article>
      <h1>Privacy Policy</h1>
      <p>
        Social Media Scheduler is a personal tool used by its single owner to schedule their own
        videos to Instagram, YouTube and Facebook. It has no other users and does not sell or share
        data.
      </p>
      <h2>What the app stores</h2>
      <ul>
        <li>The videos you upload, frames taken from them, and their transcripts.</li>
        <li>The captions, titles and descriptions written for each platform.</li>
        <li>
          Access tokens for the accounts you connect (YouTube channel, Facebook Page, Instagram
          professional account), stored encrypted.
        </li>
        <li>
          Basic status data returned by the platforms (for example, whether a video was published
          and its link).
        </li>
      </ul>
      <h2>Services used</h2>
      <ul>
        <li>
          YouTube API Services, to upload and schedule videos. See the{' '}
          <a href="https://policies.google.com/privacy">Google Privacy Policy</a>. You can revoke
          this app&apos;s access at any time at{' '}
          <a href="https://security.google.com/settings/security/permissions">
            https://security.google.com/settings/security/permissions
          </a>
          .
        </li>
        <li>Meta Graph API, to publish to your Facebook Page and Instagram account.</li>
        <li>Anthropic&apos;s Claude API, to write captions from video frames and transcripts.</li>
        <li>A speech-to-text service, to transcribe the audio of your videos.</li>
      </ul>
      <h2>Retention</h2>
      <p>
        Uploaded videos are deleted a few days after every platform has published them
        (configurable). Data received from the YouTube API is refreshed or deleted within 30 days.
        You can disconnect an account in Settings, which revokes its token and deletes the stored
        data within 7 days.
      </p>
      <h2>Contact</h2>
      <p>For any request, contact the owner of this installation.</p>
    </article>
  );
}
