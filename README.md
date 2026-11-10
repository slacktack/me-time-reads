# Paperwhite

A Kindle-style reader for the web and phone. Search any book; read 78,000+ public-domain books in-app.

## Run

```bash
npm start   # http://localhost:5173, prints a LAN address for your phone
npm test
```

Node 22+, no dependencies. On first start the server downloads the Project Gutenberg catalog (~20 MB) into `data/`.

## Where books come from

- **Read in the app:** Project Gutenberg, Standard Ebooks, and public-domain scans from the Internet Archive.
- **Everything else (via Open Library search):** links to legal free reading: borrow through Libby with your library card, borrow on Open Library, or preview on Google Books.

## Features

White, Paper and Black themes; paged or scroll reading; bookmarks; contents; font, size, spacing and margin controls; offline reading of opened books; progress and bookmarks synced through the server.
