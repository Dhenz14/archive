# ArcHive

**Archive today. Verify forever.**

ArcHive is a free tool that lets you save any webpage and prove exactly what it showed at a certain time. Unlike other screenshot tools or web archives, ArcHive makes a permanent, verifiable record on the Hive blockchain.

**Live App**: [https://dhenz14.github.io/archive](https://dhenz14.github.io/archive)

---

## Why Does This Matter?

Web content disappears all the time. Tweets get deleted, articles change, and websites go offline. If you need to prove what someone said at a certain time, screenshots can be faked. ArcHive solves this by:

1. **Extracting the actual content** from any webpage
2. **Generating cryptographic fingerprints** (hashes) that uniquely identify the content
3. **Recording those fingerprints** on a public blockchain with a timestamp that cannot be altered

If the content changes, the hashes will be different. This clearly shows if something has been tampered with.

---

## Key Features

### Cryptographic Verification
- **9-hash verification system**: SHA-256, BLAKE2b, and MD5 hashes for content, title, and overall integrity
- Each hash is a unique "fingerprint." Even changing just one character will create a completely different hash.

### Blockchain Timestamping
- Posts archive records to the Hive blockchain (free)
- Creates a timestamp that cannot be changed and can be checked by anyone
- Works with Hive Keychain extension or mobile app

### Multi-Platform Support
- **Desktop**: One-click bookmarklet for Chrome, Firefox, Brave, Edge, Safari
- **iOS Safari**: Bookmarklet method (tap from bookmarks menu)
- **Android**: Direct URL method (paste any URL into ArcHive)

### Smart Content Extraction
- Automatically pulls out the main article content and removes ads and navigation
- **Twitter/X support**: Extracts just the tweet content (with optional replies)
- Works with complex sites that have dynamic content

### Link Explorer
- Search for any URL to find existing blockchain archives
- Finds archives even if the URL has changed slightly

### Large Content Support
- If content is larger than 64KB, ArcHive automatically splits it into parts
- Posts continuation as threaded comments
- When viewing, ArcHive puts all parts back together seamlessly

### Privacy-First Design
- Everything happens on your device - all content extraction takes place in your own browser
- No server sees your content - ArcHive is made up of static files only
- Can be self-hosted on GitHub Pages, IPFS, or any static hosting

---

## How to Use ArcHive

### Desktop (Chrome, Firefox, Brave, Edge, Safari)

1. Visit [ArcHive](https://dhenz14.github.io/archive)
2. Click "Setup Bookmarklet" and drag the button to your bookmarks bar
3. Navigate to any webpage you want to archive
4. Click the ArcHive bookmark - content will be extracted right away
5. Review the preview and click "Post to Blockchain"
6. Approve in Hive Keychain - your archive is now permanent!

### iOS Safari

1. Visit ArcHive and tap "Setup Bookmarklet"
2. Follow the instructions to save the bookmarklet
3. On any webpage, tap the bookmarks icon and then tap ArcHive
4. Content opens in ArcHive, ready to post

### Android (All Browsers)

1. Copy the URL of the page you want to archive
2. Open ArcHive in your browser
3. Paste the URL into the search box and tap the archive button
4. Content is fetched and ready to post

---

## Real-World Use Cases

### Journalism & Research
Archive a company's website before any updates. This gives you blockchain-verified proof of its original content.

*Example: Archive a company's "About Us" page, product claims, or pricing before they can be altered.*

### Legal Evidence
Defamatory statements online can be quickly archived, providing verifiable proof before deletion.

*Example: Archive a social media post, review, or comment with a timestamp that holds up as evidence.*

### Academic Citation
Online sources often change or disappear, so having a permanent record is essential for citations.

*Example: Archive the exact version of an article or dataset you referenced in your paper.*

### Social Media Accountability
Public figures may delete controversial posts.

*Example: Archive tweets, threads, or posts before they are removed. ArcHive's Twitter/X feature captures only the tweet content, making it easy to read.*

### Price & Terms Monitoring
Companies change their terms of service or pricing without notice.

*Example: Archive pricing pages, terms of service, or policy documents so you can track changes over time.*

### Historical Preservation
Websites shut down and content disappears.

*Example: Archive important pages from websites that might shut down before they disappear for good.*

### Personal Protection
You need proof of what someone promised you in writing online.

*Example: Archive chat conversations, emails viewed online, or online agreements.*

---

## How to Verify an Archive

Anyone can verify an ArcHive record:

1. **Find the archive** using Link Explorer (paste the original URL)
2. **View the blockchain record** on Ecency, PeakD, or any Hive block explorer
3. **Compare the hashes** - if the content matches, the SHA-256 hash will be the same
4. **Check the timestamp** - blockchain timestamps cannot be backdated or altered

If someone says the content was different, generate the hash of their version. It will not match the blockchain record.

---

## What Makes ArcHive Different?

| Feature | ArcHive | Screenshot | Wayback Machine |
|---------|---------|------------|-----------------|
| Tamper-proof | ✅ Blockchain verified | ❌ Easily edited | ⚠️ Centralized |
| Instant | ✅ One click | ✅ One click | ❌ May not capture |
| Cryptographic proof | ✅ 9 hashes | ❌ None | ❌ None |
| Decentralized | ✅ Hive blockchain | ❌ Local file | ❌ Single organization |
| Free forever | ✅ No storage costs | ✅ Free | ✅ Free |
| Works offline | ✅ Client-side | ✅ Local | ❌ Requires service |

---

## Getting Started

### Requirements
- Any modern browser (desktop or mobile)
- Free Hive account (create at [signup.hive.io](https://signup.hive.io)) for blockchain posting
- Hive Keychain extension (desktop) or Keychain Mobile app (iOS/Android)

**No cryptocurrency required** — Hive transactions are free for content posting.

---

## Summary

ArcHive turns any webpage into a permanent, verifiable record. Since digital content is always changing or disappearing, ArcHive lets you save what matters, backed by mathematical proof that can be checked by anyone.

**Archive today. Verify forever.**
