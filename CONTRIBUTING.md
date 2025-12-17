# Contributing to ArcHive

Thank you for your interest in contributing to ArcHive! This guide will help you get started.

## Project Overview

ArcHive is a client-side web content archiving tool that creates verifiable records on the Hive blockchain. The entire application runs in the browser - there is no backend server processing content.

## Project Structure

```
archive/
├── index.html              # Main application (archiving interface)
├── hash-explorer.html      # Link Explorer (search for existing archives)
├── favicon.svg             # App icon
├── static/
│   ├── js/
│   │   ├── blakejs-browser.js    # BLAKE2b hashing library
│   │   ├── hive-lookup.js        # Hive API integration (9-node failover)
│   │   ├── indexeddb-storage.js  # IndexedDB for large content storage
│   │   ├── multipart-content.js  # Multi-part posting for large archives
│   │   └── url-normalizer.js     # Canonical URL normalization
│   └── images/
│       ├── galaxy-background.png
│       ├── hive-logo.png
│       └── hive-logo-red.png
├── README.md               # Project documentation
├── CONTRIBUTING.md         # This file
├── LICENSE                 # MIT License
└── CODE_OF_CONDUCT.md      # Community guidelines
```

## How It Works

1. **Content Extraction**: Bookmarklets extract webpage HTML directly in the user's browser
2. **Hash Generation**: SHA-256, BLAKE2b, and MD5 hashes are computed client-side
3. **Blockchain Posting**: Content is posted to Hive via Keychain extension/app
4. **Verification**: Link Explorer queries Hive nodes to find existing archives

## Development Setup

### Prerequisites
- Any modern web browser
- A text editor or IDE
- Basic knowledge of HTML, CSS, and JavaScript

### Running Locally

Since ArcHive is purely static files, you can run it with any local server:

```bash
# Using Python
python3 -m http.server 5000

# Using Node.js
npx serve -p 5000

# Using PHP
php -S localhost:5000
```

Then open `http://localhost:5000` in your browser.

### Testing Changes

1. Make your changes to the source files
2. Refresh the browser to see updates
3. Test the bookmarklet on external websites
4. Test blockchain posting with a Hive testnet account (optional)

## Areas Where Help is Needed

### Good First Issues
- Improve mobile UI/UX
- Add more hash algorithm options
- Enhance Twitter/X content extraction
- Add support for more social media platforms

### Advanced Contributions
- Modularize the main index.html into separate JS files
- Add automated testing
- Improve multi-part content handling
- Add IPFS integration for content storage

## Code Style Guidelines

- Use clear, descriptive variable names
- Add comments for complex logic
- Keep functions focused and small
- Test on both desktop and mobile browsers
- Ensure accessibility (screen reader friendly)

## Submitting Changes

1. **Fork the repository** on GitHub
2. **Create a branch** for your feature: `git checkout -b feature/my-feature`
3. **Make your changes** and test thoroughly
4. **Commit with clear messages**: `git commit -m "Add feature: description"`
5. **Push to your fork**: `git push origin feature/my-feature`
6. **Open a Pull Request** with a clear description of your changes

## Reporting Bugs

When reporting bugs, please include:
- Browser and version
- Device type (desktop/mobile)
- Steps to reproduce
- Expected vs actual behavior
- Screenshots if applicable

## Feature Requests

Feature requests are welcome! Please open an issue with:
- Clear description of the feature
- Use case explaining why it's needed
- Any implementation ideas you have

## Questions?

If you have questions about contributing, feel free to open an issue with the "question" label.

## License

By contributing to ArcHive, you agree that your contributions will be licensed under the MIT License.
