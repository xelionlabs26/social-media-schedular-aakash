export const metadata = { title: 'Data Deletion' };

export default function DataDeletionPage() {
  return (
    <article>
      <h1>Data Deletion</h1>
      <p>To delete the data this app stores about a connected account:</p>
      <ul>
        <li>Open Settings → Connected accounts and click Disconnect, or</li>
        <li>remove the app from your Facebook / Instagram / Google account settings.</li>
      </ul>
      <p>
        The app then revokes its access and deletes the stored tokens and related data within 7
        days. This does not delete anything already published on YouTube, Instagram or Facebook;
        remove those posts on the platform itself.
      </p>
    </article>
  );
}
