# Simple Label Tool

Keyboard-first web interface for labelling images across multiple categories with configurable tags. The backend serves a shared queue so every connected annotator gets a unique image until it is completed or skipped.

## Features
- Multiple categories with multi-select labels; easy to add or remove in `config.json`.
- Keyboard shortcuts for every label plus submit (`Z`), skip (`X`), and clear selections (`C`).
- Shared reservation queue backed by SQLite so an image is only shown to one person at a time.
- Built-in skip support; skipped images remain recorded with an empty label set.
- Live progress bar showing how many images are complete out of the total queue.

## Prerequisites
- Python 3.9 or newer
- Images you want to label, copied into the `images/` directory (supports `.jpg`, `.jpeg`, `.png`, `.bmp`, `.gif`, `.webp`)

## Setup
1. Install dependencies (preferably inside a virtual environment). Using [uv](https://github.com/astral-sh/uv):
   ```bash
   uv venv
   uv pip install -r requirements.txt
   ```
2. Add your images to the `images/` folder. The server scans this folder whenever a new image is requested.
3. Adjust `config.json` if you want to change categories, labels, shortcuts, or the reservation timeout.

## Running the Server
```bash
python app.py
```

The app listens on `http://0.0.0.0:5000`, so you can share that URL (or the machine's public hostname and port) with other users on your network. Each browser session reserves an image when it loads and releases it once the image is submitted or skipped.

## Using the Labelling UI
- Shortcuts are shown next to each label; press a shortcut to toggle it.
- `Z` submits the current selections.
- `X` skips the image without applying any labels.
- `C` clears all selections for the current image.
- The status banner at the top reports reservation and submission results. When all images are complete, the UI confirms that the queue is empty.

## Data Output
Label selections are stored in `data/labels.db` in the `images` table. Each row contains:
- `filename`: original image filename
- `status`: `pending`, `in_progress`, or `done`
- `labels_json`: JSON object mapping category IDs to arrays of the selected label phrases; empty object for skipped images
- `skipped`: `1` if the image was skipped, otherwise `0`

You can inspect the database with any SQLite tool, for example:
```bash
sqlite3 data/labels.db "SELECT filename, labels_json, skipped FROM images WHERE status='done';"
```

For a browser-based view, open `http://<host>:5000/labels`. Use the controls at the top of the page to filter by status or limit the number of rows displayed; all records are rendered in a sortable-friendly table for easy scanning.

## Customising Categories & Shortcuts
Edit `config.json` to change the taxonomy. Example structure:
```json
{
  "image_directory": "images",
  "reservation_timeout_seconds": 300,
  "categories": [
    {
      "id": "hands",
      "name": "Hands",
      "labels": [
        {"name": "disfigured hand", "shortcut": "1"}
      ]
    }
  ]
}
```
- `shortcut` entries are optional; when omitted the UI assigns unused keys automatically.
- Restart the server after modifying `config.json` to pick up the changes.
