/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Every edit here is erased by the next `npm run api:generate`. This file
 * describes what the backend actually serves; if a type is wrong, the fix is in
 * the FastAPI route's response model, not here.
 *
 * Source: renderer/api-schema.json (a committed copy of the backend's
 * /openapi.json). To refresh it against a running server:
 *
 *   npm run api:generate -- --from http://127.0.0.1:8000 --save
 *
 * Routes that declare no response model in Python arrive here as `unknown`.
 * That is accurate, not a generator failure — annotate the route to fix it.
 */

export interface paths {
    "/api/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Events */
        get: operations["events_api_events_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/listar-albums": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Listar Albums */
        get: operations["listar_albums_api_listar_albums_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/listar-albums-con-metadata": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Listar Albums Con Metadata
         * @description The library with per-track metadata.
         *
         *     ⚠ **`covers=true` is expensive and the default only for compatibility.**
         *     Inlining every cover as a base64 data URI makes this response ~30 MB on a
         *     178-album library — measured 32,097,488 bytes — of which ~30 MB is the
         *     covers. On a LAN that is a 1-second request and nobody notices. Over a phone
         *     tunnel it is tens of seconds of the *home upstream*, and that long window is
         *     what let an ordinary tab switch cancel the load on iOS (`NSURLErrorCancelled`),
         *     which read as "the library is broken" while every smaller request worked.
         *
         *     `covers=false` returns `"cover": null` and nothing else changes, so a client
         *     that fetches `/api/media/{dir}/cover.jpg` per album — which is what both the
         *     iOS client and any lazy-loading UI already do — pays a few KB instead. The
         *     flag is opt-in rather than the default because the Electron renderer still
         *     reads the inlined field, and flipping the default would blank every cover in
         *     the desktop app.
         */
        get: operations["listar_albums_con_metadata_api_listar_albums_con_metadata_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/media/{album}/cover.jpg": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Serve Cover */
        get: operations["serve_cover_api_media__album__cover_jpg_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/media/{album}/{filename}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Serve Audio
         * @description Stream one audio file, with Range.
         *
         *     ⚠ Path validation only — no tag parsing. This used to go through
         *     ``get_track``, which opens the file with mutagen and can schedule a librosa
         *     analysis, and a playing song arrives as one Range request every couple of
         *     seconds (68 requests measured for one three-minute song), so that work
         *     ran dozens of times per song before a single byte was streamed.
         */
        get: operations["serve_audio_api_media__album___filename__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/waveform/{album}/{filename}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Waveform */
        get: operations["get_waveform_api_waveform__album___filename__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/wavesurfer-peaks/{album}/{filename}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Wavesurfer Peaks */
        get: operations["get_wavesurfer_peaks_api_wavesurfer_peaks__album___filename__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/delete-track": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Delete Track
         * @description Delete a track file from disk. The path must resolve under the music root.
         */
        post: operations["delete_track_api_delete_track_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/move-track": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Move Track
         * @description Move a song the library already has into this album: no download.
         *
         *     The «Mover aquí» resolve verb — the same recording filed under its single
         *     while the album page lists it. Every user's row, every playlist, its lyric
         *     and its stems follow the file. 409 when the album already holds a
         *     different file of that name.
         */
        post: operations["move_track_api_library_move_track_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/update-tags": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Update Tags
         * @description Edit a track's ID3 tags. MP3 only (the tag writer is MP3-based).
         */
        post: operations["update_tags_api_update_tags_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/ownership": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Check Ownership
         * @description Which of these catalog tracks does the library already contain?
         *
         *     Batch rather than per-track on purpose: an album page asks about its whole
         *     tracklist at once, and the index is built once for the batch. A per-track
         *     endpoint would invite N round trips for one page.
         *
         *     Never fails the page. A library that cannot be read is reported as owning
         *     nothing, because a browse page that renders without ownership markers is
         *     far better than one that does not render.
         */
        post: operations["check_ownership_api_library_ownership_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/analysis/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Summary */
        get: operations["summary_api_analysis_summary_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/analysis/estimates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Estimates */
        get: operations["estimates_api_analysis_estimates_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/analysis/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create Run */
        post: operations["create_run_api_analysis_runs_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/analysis/runs/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Preview Run */
        get: operations["preview_run_api_analysis_runs_preview_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/analysis/{album}/{file}/replaygain": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Replaygain */
        get: operations["replaygain_api_analysis__album___file__replaygain_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/analysis/{relPath}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read */
        get: operations["read_api_analysis__relPath__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/analysis/{relPath}/fixed": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Fixed */
        put: operations["fixed_api_analysis__relPath__fixed_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/scan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Scan Status */
        get: operations["scan_status_api_library_scan_get"];
        put?: never;
        /** Request Scan */
        post: operations["request_scan_api_library_scan_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Library Health */
        get: operations["library_health_api_library_health_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/tags/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Batch */
        post: operations["batch_api_library_tags_batch_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/tags/{relPath}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read */
        get: operations["read_api_library_tags__relPath__get"];
        /** Edit */
        put: operations["edit_api_library_tags__relPath__put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/edits": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** History */
        get: operations["history_api_library_edits_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/edits/{editId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Detail */
        get: operations["detail_api_library_edits__editId__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/edits/{editId}/undo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Undo */
        post: operations["undo_api_library_edits__editId__undo_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/missing": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Listing */
        get: operations["listing_api_library_missing_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/missing/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Preview */
        post: operations["preview_api_library_missing_preview_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/missing/apply": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Apply */
        post: operations["apply_api_library_missing_apply_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/missing/remove": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Remove */
        post: operations["remove_api_library_missing_remove_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/match": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Start */
        post: operations["start_api_library_match_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/match/{jobId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** View */
        get: operations["view_api_library_match__jobId__get"];
        put?: never;
        post?: never;
        /** Cancel */
        delete: operations["cancel_api_library_match__jobId__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/match/{jobId}/plan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Plan */
        post: operations["plan_api_library_match__jobId__plan_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/edits/{planId}/apply": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Apply */
        post: operations["apply_api_library_edits__planId__apply_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/duplicates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Listing */
        get: operations["listing_api_library_duplicates_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/duplicates/scan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Scan */
        post: operations["scan_api_library_duplicates_scan_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/duplicates/{groupId}/keeper": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Keeper */
        put: operations["keeper_api_library_duplicates__groupId__keeper_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/duplicates/{groupId}/dismiss": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Dismiss */
        post: operations["dismiss_api_library_duplicates__groupId__dismiss_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/acquisition/requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Requests */
        get: operations["list_requests_api_acquisition_requests_get"];
        put?: never;
        /** Request Acquisition */
        post: operations["request_acquisition_api_acquisition_requests_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/acquisition/requests/clear": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Clear Requests */
        post: operations["clear_requests_api_acquisition_requests_clear_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/acquisition/requests/{id}/clear": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Clear Request */
        post: operations["clear_request_api_acquisition_requests__id__clear_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/acquisition/requests/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Request */
        get: operations["get_request_api_acquisition_requests__id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/acquisition/requests/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel Request */
        post: operations["cancel_request_api_acquisition_requests__id__cancel_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/acquisition/requests/{id}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry Request */
        post: operations["retry_request_api_acquisition_requests__id__retry_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/uploads/space": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Upload Space */
        get: operations["upload_space_api_uploads_space_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/uploads/check": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Check Uploads */
        post: operations["check_uploads_api_uploads_check_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/uploads/batches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create Batch */
        post: operations["create_batch_api_uploads_batches_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/uploads/batches/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Batch */
        get: operations["get_batch_api_uploads_batches__id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/uploads/batches/{id}/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Start Batch */
        post: operations["start_batch_api_uploads_batches__id__start_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/uploads/batches/{id}/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Stop Batch */
        post: operations["stop_batch_api_uploads_batches__id__stop_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/uploads/batches/{id}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry Batch */
        post: operations["retry_batch_api_uploads_batches__id__retry_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/uploads/batches/{id}/files/{sha}/fail": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Fail Upload */
        post: operations["fail_upload_api_uploads_batches__id__files__sha__fail_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/uploads/batches/{id}/files/{sha}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        /** Upload Offset */
        head: operations["upload_offset_api_uploads_batches__id__files__sha__head"];
        /** Upload Chunk */
        patch: operations["upload_chunk_api_uploads_batches__id__files__sha__patch"];
        trace?: never;
    };
    "/api/download-album-song": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Download Album Song */
        post: operations["download_album_song_api_download_album_song_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/download-single-song": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Download Single Song
         * @description Download single song from Genius URL.
         *
         *     Args:
         *         data: Download request with Genius URL
         *
         *     Returns:
         *         Download result
         */
        post: operations["download_single_song_api_download_single_song_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/download-youtube-url": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Download Source Url
         * @description Download audio directly from source URL.
         *     Optional name from filename or nombre_archivo (Nombre opcional).
         */
        post: operations["download_youtube_url_api_download_youtube_url_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/download-search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Download Search
         * @description Download audio from search term.
         *
         *     Searches the source for the given term and downloads the best match.
         *
         *     Args:
         *         data: Search term and download options
         *
         *     Returns:
         *         Download result
         */
        post: operations["download_search_api_download_search_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/search-spotify-tracks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Search Spotify Tracks
         * @description Search Spotify for individual songs (client-credentials, no user login).
         *
         *     Returns track results shaped for the download flow; the frontend sends a
         *     chosen result back to /download-spotify-playlist as a one-item list.
         */
        post: operations["search_spotify_tracks_api_search_spotify_tracks_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/download-spotify-playlist": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Download Spotify Playlist
         * @description Start downloading tracks from a Spotify playlist (a single picked search result
         *     is sent as a one-item list).
         *
         *     Non-blocking: mints a progress id, registers it synchronously so the SSE stream
         *     can attach immediately, runs the download as a background task, and returns the
         *     progress id right away. Per-track phase/percent progress and the final outcome
         *     are delivered over GET /download-progress-stream/{progress_id}.
         */
        post: operations["download_spotify_playlist_api_download_spotify_playlist_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/fetch-spotify-playlist": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Fetch Spotify Playlist
         * @description Fetch Spotify playlist info for display (name, cover, tracks). Does not download.
         */
        post: operations["fetch_spotify_playlist_api_fetch_spotify_playlist_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/import-playlist-url": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Import Playlist Url
         * @description Start importing and downloading a playlist from a URL, in the background.
         *
         *     Non-blocking, mirroring /download-spotify-playlist so the playlist mode streams
         *     into the "Descargas activas" panel like single-track downloads do. The track
         *     count isn't known until the playlist is fetched, so the progress entry is
         *     registered synchronously at total=0 (lets the SSE stream attach without racing a
         *     404) and resized once import_playlist_from_url resolves the list. Per-track
         *     phase/percent and the final outcome are delivered over GET
         *     /download-progress-stream/{progress_id}. The playlist JSON is still saved to
         *     Krobi/playlists after a successful import.
         */
        post: operations["import_playlist_url_api_import_playlist_url_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/downloads/active": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Active Downloads
         * @description Every download the backend currently knows about.
         *
         *     The missing piece that made downloads invisible: progress entries were only
         *     ever reachable by an id the *starting* component happened to be holding, so
         *     a job vanished from the UI as soon as that component unmounted — which
         *     `App.jsx` does on every navigation — and a job started anywhere else (a
         *     browse acquisition, another window, the session before a reload) was never
         *     visible at all.
         *
         *     ``include_finished_seconds`` lets a client show a job's outcome for a
         *     moment after it ends rather than having it disappear at the instant it
         *     matters most. Terminal entries are kept by ``ProgressTracker`` until
         *     ``cleanup_old_progress`` runs, so this filters by age rather than assuming
         *     they are gone.
         *
         *     ⚠ ``ProgressTracker`` is per-process memory, so this is only complete while
         *     the backend runs a single worker — the same constraint the SSE stream has.
         */
        get: operations["list_active_downloads_api_downloads_active_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/download-progress/{progress_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Download Progress
         * @description Get download progress status.
         *
         *     Args:
         *         progress_id: Progress tracker ID
         *
         *     Returns:
         *         Progress status
         */
        get: operations["get_download_progress_api_download_progress__progress_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/download-progress-stream/{progress_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Stream Download Progress
         * @description Stream download progress as Server-Sent Events.
         *
         *     Backed by the same thread-safe ProgressTracker as the polling endpoint above, so
         *     it works for every download mode (playlist batch, single-track one-click, …)
         *     without per-mode wiring — the stream is keyed purely by ``progress_id``. It
         *     pushes a `data:` event with the current snapshot whenever the tracker changes,
         *     then closes once the operation reaches a terminal status. The frontend consumes
         *     it via EventSource instead of polling. The legacy GET snapshot endpoint above is
         *     kept as a fallback for clients that don't speak SSE.
         */
        get: operations["stream_download_progress_api_download_progress_stream__progress_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/downloads/youtube-search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Source Search
         * @description Raw source results for one phrasing — no matcher, no veto: the person chooses.
         */
        post: operations["youtube_search_api_downloads_youtube_search_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/downloads/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Retry Download
         * @description Download a failed song from the video the person picked, as a new job.
         */
        post: operations["retry_download_api_downloads_retry_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Download
         * @description Legacy alias for download-album-song.
         */
        post: operations["download_api_download_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/spotify/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Spotify Status
         * @description Whether Spotify creds are configured and an account is connected.
         */
        get: operations["spotify_status_api_spotify_status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/spotify/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Spotify Login
         * @description Redirect the user to Spotify's consent screen (open in a browser).
         */
        get: operations["spotify_login_api_spotify_login_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/spotify/authorize-url": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Spotify Authorize Url
         * @description Spotify's consent URL for an authenticated client, which opens it in a browser.
         *
         *     /spotify/login redirects instead, but a browser opening it carries no token.
         */
        get: operations["spotify_authorize_url_api_spotify_authorize_url_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/spotify/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Spotify Callback
         * @description Public redirect; its one-shot state is issued by the owner-only login.
         */
        get: operations["spotify_callback_api_spotify_callback_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/spotify/disconnect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Spotify Disconnect */
        post: operations["spotify_disconnect_api_spotify_disconnect_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/buscar-cover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Buscar Cover
         * @description Fetch album cover from Genius URL.
         *
         *     Args:
         *         data: Request with Genius URL
         *
         *     Returns:
         *         Base64 encoded cover image
         */
        post: operations["buscar_cover_api_buscar_cover_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/buscar-album-info": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Buscar Album Info
         * @description Search for album information on Genius.
         *
         *     Args:
         *         data: Request with Genius URL or search query
         *
         *     Returns:
         *         Album information with tracks (legacy format for frontend compatibility)
         */
        post: operations["buscar_album_info_api_buscar_album_info_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/buscar-canciones": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Buscar Canciones
         * @description Search for songs on Genius.
         *
         *     Args:
         *         data: Search request with query term
         *
         *     Returns:
         *         List of matching songs
         */
        post: operations["buscar_canciones_api_buscar_canciones_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/buscar": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Buscar
         * @description Legacy alias for buscar-album-info.
         */
        post: operations["buscar_api_buscar_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/playlists": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Playlists
         * @description The playlists this caller may see: their own, or all of them for an owner.
         *
         *     ``owner`` is additive — the renderer and the iOS client read ``name`` /
         *     ``trackCount`` / ``created`` / ``modified`` and ignore the rest — and it is
         *     what lets a client mark "yours" without a second request.
         */
        get: operations["list_playlists_api_playlists_get"];
        put?: never;
        /** Create Playlist */
        post: operations["create_playlist_api_playlists_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/playlists/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Playlist
         * @description Get a specific playlist.
         *
         *     Args:
         *         name: Playlist name
         *
         *     Returns:
         *         Playlist with tracks (legacy format for frontend compatibility)
         */
        get: operations["get_playlist_api_playlists__name__get"];
        put?: never;
        post?: never;
        /**
         * Delete Playlist
         * @description Delete a playlist.
         *
         *     Args:
         *         name: Playlist name
         *
         *     Returns:
         *         Success message
         */
        delete: operations["delete_playlist_api_playlists__name__delete"];
        options?: never;
        head?: never;
        /**
         * Rename Playlist
         * @description Rename a playlist.
         *
         *     Args:
         *         name: Current playlist name
         *         data: New name
         *
         *     Returns:
         *         The renamed playlist (nested {success, playlist} envelope)
         */
        patch: operations["rename_playlist_api_playlists__name__patch"];
        trace?: never;
    };
    "/api/playlists/{name}/tracks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Update Playlist Tracks
         * @description Update tracks in a playlist.
         *
         *     Args:
         *         name: Playlist name
         *         tracks: New list of tracks
         *
         *     Returns:
         *         Updated playlist
         */
        put: operations["update_playlist_tracks_api_playlists__name__tracks_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/refresh-playlist/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Refresh Playlist From Source
         * @description Refresh playlist from source_url: fetch current tracks from Spotify/URL,
         *     download only new tracks, append to playlist. Legacy path for frontend.
         */
        post: operations["refresh_playlist_from_source_api_refresh_playlist__name__post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/playlists/{name}/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Refresh Playlist
         * @description Refresh playlist metadata and validate tracks (from file tags).
         */
        post: operations["refresh_playlist_api_playlists__name__refresh_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/playlists/spotify-export/parse": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Parse Spotify Export Upload
         * @description Parse an uploaded Spotify data export. Reads nothing, writes nothing.
         *
         *     Multipart upload under the field name ``file`` (a ``.zip`` or a single
         *     ``.json`` out of one). Pure function of the bytes: no network call, no
         *     filesystem write, nothing queued. It answers "what is in this archive?" so
         *     the user can pick a playlist before anything slower starts.
         *
         *     Returns ``ExportParseResult.to_dict()``:
         *     ``{playlistCount, trackCount, warnings, sourceFiles, unreadMembers,
         *     unrecognizedCount, playlists: [...]}``.
         *
         *     ``unreadMembers`` is the diagnostic half: every archive member that produced
         *     no playlists, categorised ``ignored`` / ``known`` / ``unrecognized`` /
         *     ``unreadable``. Only ``unrecognized`` means "the layout is not what we
         *     expected", and the frontend surfaces exactly those.
         */
        post: operations["parse_spotify_export_upload_api_playlists_spotify_export_parse_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/playlists/spotify-export/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Resolve Spotify Export Tracks
         * @description Start resolving exported tracks to real recordings. Downloads nothing.
         *
         *     Non-blocking, following the download endpoints exactly: mint a progress id,
         *     register it synchronously so a client attaching to
         *     ``GET /api/download-progress-stream/{progress_id}`` can never race a 404,
         *     run the work in the background, return the id immediately.
         *
         *     Resolution is per-track and rate-limited by the providers (MusicBrainz
         *     allows 1 req/s), so a large playlist runs for a long time. It reports
         *     progress per item and is cancellable between items via
         *     ``POST /api/playlists/spotify-export/resolve/{progress_id}/cancel``.
         *
         *     Results are read back from
         *     ``GET /api/playlists/spotify-export/resolve/{progress_id}``, grouped by
         *     confidence. Nothing here downloads: importing is a separate, explicit call
         *     carrying the list the user confirmed.
         */
        post: operations["resolve_spotify_export_tracks_api_playlists_spotify_export_resolve_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/playlists/spotify-export/resolve/{progress_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Spotify Export Resolution
         * @description Read a resolution's results, grouped by confidence.
         *
         *     Readable while the job is still running, so a long resolution can be
         *     reviewed as it fills in rather than only at the end. ``status`` is one of
         *     ``in_progress``, ``done``, ``cancelled``, ``failed``.
         */
        get: operations["get_spotify_export_resolution_api_playlists_spotify_export_resolve__progress_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/playlists/spotify-export/resolve/{progress_id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cancel Spotify Export Resolution
         * @description Ask a running resolution to stop.
         *
         *     Cooperative: the worker checks the flag between lookups, so an in-flight
         *     provider request finishes first and the job stops within roughly one lookup.
         *     A thread cannot be interrupted mid-call, and killing one mid-request would
         *     leak the connection. Whatever resolved before the stop is kept and stays
         *     readable. A no-op on a job that already finished.
         */
        post: operations["cancel_spotify_export_resolution_api_playlists_spotify_export_resolve__progress_id__cancel_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/playlists/spotify-export/import": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Import Spotify Export Tracks
         * @description Download the tracks the user confirmed, and save them as a playlist.
         *
         *     The only endpoint in this trio that acquires anything, and it acquires
         *     exactly the list in the body -- never the resolve step's own output. Queues
         *     through the same download service as every other download mode, so it
         *     streams over ``GET /api/download-progress-stream/{progress_id}`` with the
         *     same shape the frontend already renders.
         */
        post: operations["import_spotify_export_tracks_api_playlists_spotify_export_import_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/upload-selected-vlc": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Upload Selected Vlc
         * @description Upload selected tracks to VLC.
         *
         *     Args:
         *         request: VLC upload request with paths and IP
         *
         *     Returns:
         *         Upload result
         */
        post: operations["upload_selected_vlc_api_upload_selected_vlc_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/upload-audio-vlc": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Upload Audio Vlc
         * @description Upload all audio from music directory to VLC.
         *
         *     Args:
         *         vlc_ip: VLC HTTP interface IP address
         *
         *     Returns:
         *         Upload result
         */
        post: operations["upload_audio_vlc_api_upload_audio_vlc_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/dashboard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Dashboard Endpoint
         * @description The browse page's four rows.
         *
         *     ``{"rows": [...], "cachedAt": "...", "stale": bool}``. ``stale: true`` means at least one row is
         *     the last good copy because the provider failed — the UI is expected to say
         *     so rather than present day-old charts as fresh.
         *
         *     ``?refresh=true`` bypasses the TTL. It exists for a manual "reload" affordance
         *     and for support; it is **not** something the page should call on mount, which
         *     would defeat the cache that Deezer's per-IP quota requires.
         *
         *     There is no error status code here on purpose. A dashboard provider failing
         *     is a normal, expected condition, and the requirement is that it never blanks
         *     the page — so every path returns 200 with whatever rows exist and per-row
         *     ``error`` strings for the rest.
         */
        get: operations["get_dashboard_endpoint_api_dashboard_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/browse/album/{provider}/{album_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Album
         * @description An album header and its real tracklist, ready to acquire from.
         */
        get: operations["get_album_api_browse_album__provider___album_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/browse/artist/{provider}/{artist_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Artist
         * @description An artist page: whichever sections this provider declared it can serve.
         */
        get: operations["get_artist_api_browse_artist__provider___artist_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/browse/playlist/{provider}/{playlist_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Playlist
         * @description A playlist and its tracks.
         */
        get: operations["get_playlist_api_browse_playlist__provider___playlist_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/browse/genre/{provider}/{genre_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Genre
         * @description A genre's own chart: top songs, albums, artists and lists.
         */
        get: operations["get_genre_api_browse_genre__provider___genre_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/browse/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search
         * @description Catalog search, split by kind.
         *
         *     ``provider`` is optional here and required in the path routes above: a
         *     search has no entity id to be ambiguous about, so the user's provider order
         *     picks — which is what makes reordering in Ajustes → Fuentes visible.
         */
        get: operations["search_api_browse_search_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/browse/acquire": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Acquire
         * @description Acquire catalog tracks: link what is already here, download what is not.
         *
         *     This is the terminal action of browsing, and the reason the identity work
         *     pays off: every track arrives with a real title, artist, album, duration and
         *     track number, so ``select_video`` vetoes a wrong source pick against a known
         *     recording instead of against a string somebody typed from memory.
         *
         *     **The dedupe hit is the important half.** A track the shared catalog already holds is
         *     not downloaded again: the caller gets a ``user_track`` row and the song is
         *     instantly theirs — no source request, no queue, no wait. After the first few
         *     months this is meant to be the common case, and it is the entire reason one
         *     household shares one catalog.
         *
         *     A miss queues exactly as before and the requester is linked when the file
         *     lands (see ``_run`` below).
         *
         *     ⚠ **A sentinel principal — the Electron desktop, on loopback or with
         *     ``KROBI_API_TOKEN`` — cannot hold library rows** (``/api/me/library`` answers
         *     409 for it). Acquisition does not inherit that refusal: it downloads exactly
         *     as it always has and simply skips the linking, silently. ``linking`` in the
         *     response says which of the two happened.
         *
         *     Returns a ``progress_id`` immediately and runs in the background.
         *     ``GET /api/download-progress-stream/{id}`` is source-agnostic — keyed purely
         *     by the id — so no new streaming machinery is needed here.
         */
        post: operations["acquire_api_browse_acquire_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Lyrics Jobs
         * @description What the lyrics worker is doing, and which songs the catalogs lacked.
         */
        get: operations["lyrics_jobs_api_lyrics_jobs_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/pending": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Lyrics Pending
         * @description Every song the catalogs lacked, newest first — `/jobs` names only a preview.
         */
        get: operations["lyrics_pending_api_lyrics_pending_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/states": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Lyrics States */
        get: operations["lyrics_states_api_lyrics_states_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/scan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Lyrics Scan
         * @description Ask the catalogs for every song without a lyric. One pass at a time.
         */
        post: operations["lyrics_scan_api_lyrics_scan_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Lyrics Search
         * @description Every enabled catalog's answer for one song, ranked; nothing is written.
         */
        post: operations["lyrics_search_api_lyrics_search_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Lyrics Config */
        get: operations["get_lyrics_config_api_lyrics_config_get"];
        /**
         * Put Lyrics Config
         * @description Persist the auto-fetch switch to <root>/.env and apply it live.
         *
         *     Same mechanics as the analysis-tags switch. Turning it on also starts a
         *     pass right away — the person flipped it because they want lyrics now.
         */
        put: operations["put_lyrics_config_api_lyrics_config_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/engine": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Lyrics Engine Status
         * @description Is the engine installed, ready, installing, busy — and if not, why (a hint code).
         */
        get: operations["lyrics_engine_status_api_lyrics_engine_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/engine/remove": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Lyrics Engine Remove */
        post: operations["lyrics_engine_remove_api_lyrics_engine_remove_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/engine/install": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Lyrics Engine Install
         * @description Install the shared runtime or one add-on's models in the background.
         */
        post: operations["lyrics_engine_install_api_lyrics_engine_install_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/align": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Align Lyrics */
        post: operations["align_lyrics_api_lyrics_align_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/transcribe": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Lyrics Transcribe
         * @description Process songs on this Mac: align when a text is known, transcribe otherwise.
         */
        post: operations["lyrics_transcribe_api_lyrics_transcribe_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/transcribe/pending": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Lyrics Transcribe Pending
         * @description Every song the catalogs did not have, through the engine.
         */
        post: operations["lyrics_transcribe_pending_api_lyrics_transcribe_pending_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/transcribe/{progress_id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Lyrics Transcribe Cancel */
        post: operations["lyrics_transcribe_cancel_api_lyrics_transcribe__progress_id__cancel_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/agent/claim": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Lyrics Agent Claim */
        post: operations["lyrics_agent_claim_api_lyrics_agent_claim_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/agent/heartbeat": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Lyrics Agent Heartbeat */
        post: operations["lyrics_agent_heartbeat_api_lyrics_agent_heartbeat_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/agent/bye": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Lyrics Agent Bye */
        post: operations["lyrics_agent_bye_api_lyrics_agent_bye_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/agent/result": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Lyrics Agent Result */
        post: operations["lyrics_agent_result_api_lyrics_agent_result_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/{album}/{file}/offset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Put Lyrics Offset */
        put: operations["put_lyrics_offset_api_lyrics__album___file__offset_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lyrics/{album}/{file}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Lyrics */
        get: operations["get_lyrics_api_lyrics__album___file__get"];
        /** Put Lyrics */
        put: operations["put_lyrics_api_lyrics__album___file__put"];
        post?: never;
        /** Delete Lyrics */
        delete: operations["delete_lyrics_api_lyrics__album___file__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/stems/request": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Stems Request
         * @description Ask for a track's stems. ``ready`` = already on disk, no new job.
         */
        post: operations["stems_request_api_stems_request_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/stems": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Stems List */
        get: operations["stems_list_api_stems_get"];
        put?: never;
        post?: never;
        /** Stems Delete All */
        delete: operations["stems_delete_all_api_stems_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/stems/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Stems Jobs
         * @description Every live or failed job, and whether a worker is calling in.
         */
        get: operations["stems_jobs_api_stems_jobs_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/stems/agent/claim": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Stems Agent Claim */
        post: operations["stems_agent_claim_api_stems_agent_claim_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/stems/agent/heartbeat": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Stems Agent Heartbeat */
        post: operations["stems_agent_heartbeat_api_stems_agent_heartbeat_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/stems/agent/result": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Stems Agent Result
         * @description Multipart: ``id``, ``song.json`` and the four stems (``drums``/``bass``/``vocals``/``other``,
         *     Opus in Ogg) — or ``id``, ``ok=false``, ``error``, ``final`` for a failure.
         */
        post: operations["stems_agent_result_api_stems_agent_result_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/stems/{album}/{file}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Stems Get
         * @description ``200`` the manifest (song.json) when ready, ``202`` while not, ``404`` never requested.
         */
        get: operations["stems_get_api_stems__album___file__get"];
        put?: never;
        post?: never;
        /** Stems Delete */
        delete: operations["stems_delete_api_stems__album___file__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/stems/{album}/{file}/{stem}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Stems Audio
         * @description One stem, Opus in Ogg, with Range — same streaming as ``/api/media``.
         */
        get: operations["stems_audio_api_stems__album___file___stem__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/helpers/claim": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Claim */
        post: operations["claim_api_helpers_claim_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/helpers/jobs/{id}/heartbeat": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Heartbeat */
        post: operations["heartbeat_api_helpers_jobs__id__heartbeat_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/helpers/jobs/{id}/result": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Result */
        post: operations["result_api_helpers_jobs__id__result_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/helpers/bye": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Bye */
        post: operations["bye_api_helpers_bye_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/compute/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Summary */
        get: operations["summary_api_compute_summary_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/compute/kinds/{kind}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Update Kind */
        put: operations["update_kind_api_compute_kinds__kind__put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/compute/computers/{identity}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Update Computer */
        put: operations["update_computer_api_compute_computers__identity__put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/compute/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Pause */
        put: operations["pause_api_compute_pause_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/helpers/limits": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Own Limits */
        get: operations["own_limits_api_helpers_limits_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Jobs */
        get: operations["list_jobs_api_jobs_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/jobs/clear": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Clear Jobs */
        post: operations["clear_jobs_api_jobs_clear_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/jobs/{job_id}/clear": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Clear Job */
        post: operations["clear_job_api_jobs__job_id__clear_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/jobs/{job_id}/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Job Items */
        get: operations["job_items_api_jobs__job_id__items_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/jobs/{job_id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel Job */
        post: operations["cancel_job_api_jobs__job_id__cancel_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/jobs/{job_id}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry Job */
        post: operations["retry_job_api_jobs__job_id__retry_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/config/genius": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Genius Credentials Status */
        get: operations["genius_credentials_status_api_config_genius_get"];
        /** Set Genius Credentials */
        put: operations["set_genius_credentials_api_config_genius_put"];
        post?: never;
        /** Delete Genius Credentials */
        delete: operations["delete_genius_credentials_api_config_genius_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/providers/youtube/ytdlp/update": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Update Source Tool */
        post: operations["update_ytdlp_api_providers_youtube_ytdlp_update_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/providers/{provider_id}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry Provider */
        post: operations["retry_provider_api_providers__provider_id__retry_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/providers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Providers
         * @description Every registered provider, in effective order, disabled ones included.
         *
         *     The panel has to render what you switched off, so this is not
         *     ``registry.order()`` — that is the consumer-facing list and it filters.
         */
        get: operations["list_providers_api_providers_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/providers/{provider_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set Provider Enabled
         * @description Toggle one provider and return its updated row.
         *
         *     422 rather than a silent no-op when this would disable the last enabled
         *     provider of a kind: an empty metadata kind means every import rejects every
         *     track, and a settings toggle must not be able to break resolution invisibly.
         */
        put: operations["set_provider_enabled_api_providers__provider_id__put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/providers/{kind}/order": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set Provider Order
         * @description Replace a kind's priority order with a full permutation of its ids.
         *
         *     422 on an unknown or missing id. A partial order is ambiguous — do the
         *     omitted providers go first, last, or keep their old slots? — and guessing is
         *     worse than refusing.
         */
        put: operations["set_provider_order_api_providers__kind__order_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/sources/missing": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Missing Sources */
        get: operations["missing_sources_api_sources_missing_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/sources/known": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Known Sources */
        get: operations["list_known_sources_api_sources_known_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/sources/install": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Install Source */
        post: operations["install_source_api_sources_install_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/sources/{id}/action": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Source Action */
        post: operations["source_action_api_sources__id__action_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/sources/{id}/update": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Update Source */
        post: operations["update_source_api_sources__id__update_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/sources/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove Source */
        delete: operations["remove_source_api_sources__id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Whoami
         * @description Who the caller is, as ``require_api_token`` already decided it.
         *
         *     Keys mirror ``UserRecord.public()`` exactly (``id``/``label``/``role``/
         *     ``createdAt``/``lastSeenAt``) so a client can compare this body against the
         *     rows of ``GET /api/users`` field for field — marking its own row, and knowing
         *     before it asks whether a revoke would destroy the credential it is holding.
         *     ``isOwner`` saves every client from re-deriving the one rule that matters,
         *     and ``source`` says which *kind* of principal answered:
         *
         *     ``token``          a real row in ``users.json``; ``id`` is revocable and the
         *                        two timestamps are that row's. They are ``null`` in the
         *                        one race where the row was revoked between the gate and
         *                        this handler — the credential is spent, but it was a real
         *                        one and saying otherwise would be a lie.
         *     ``shared-secret``  ``KROBI_API_TOKEN``, a synthetic owner with no row.
         *     ``local``          loopback on a backend with no token configured.
         *     ``anonymous``      ``KROBI_ALLOW_UNAUTHENTICATED_REMOTE``; member, never owner.
         *     ``unknown``        the ``current_principal`` fallback. Unreachable unless a
         *                        router is ever included without the gate, and returned
         *                        honestly rather than dressed up as a user.
         *
         *     The sentinels carry ``null`` timestamps because they have none — inventing a
         *     ``createdAt`` would make a synthetic owner indistinguishable from a row that
         *     can actually be managed.
         *
         *     Identity fields come from the principal, not from the row: the principal is
         *     what this request was *authorized* as, and the row is only consulted for the
         *     two things the principal does not carry. Nothing here reads
         *     a token digest — those live on ``DeviceRecord`` inside the store and no
         *     response body may ever contain one.
         */
        get: operations["whoami_api_me_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/attention": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read Attention */
        get: operations["read_attention_api_me_attention_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List My Devices
         * @description Every machine signed in to the calling account, oldest first.
         *
         *     Metadata only: the store holds sha256 digests and no body on this surface
         *     may ever contain one. ``isCurrent`` marks the credential this request
         *     arrived with, so a settings panel can label it "this device" and warn the
         *     user before they sign out the phone they are holding.
         *
         *     An account whose row vanished between the gate and this handler — revoked by
         *     an owner mid-request — answers an empty list rather than a 500. The
         *     credential is spent and the next request will be a 401, which is the honest
         *     place for that to surface.
         */
        get: operations["list_my_devices_api_me_devices_get"];
        put?: never;
        /**
         * Add My Device
         * @description Mint another token **for the caller's own account**. The feature.
         *
         *     The Mac joins the phone's account: the new credential resolves to the same
         *     ``user_id``, so it sees the same per-user library, the same likes and the
         *     same playlists, and it is separately revocable.
         *
         *     ⚠ Not ``POST /api/users``. That one is owner-only and creates a *person* —
         *     a second library, a second set of likes, a second identity in the log — and
         *     using it to pair a second machine is the defect this route exists to fix.
         *     The account here is read off the principal and can never come from the body.
         *
         *     ``token`` in the response is the only time the secret exists; the store
         *     keeps a digest and cannot reproduce it.
         */
        post: operations["add_my_device_api_me_devices_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/devices/api-key": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Add My Api Key
         * @description Mint an OpenSubsonic API key for the caller's own account.
         *
         *     ``token`` is shown once. Only its SHA-256 verifier is stored in the account
         *     directory; no recoverable copy goes into the app-password vault. List and
         *     revoke it through ``GET /api/me/devices`` and ``DELETE /api/me/devices/{id}``,
         *     exactly like an app password. Owners and members mint only for themselves.
         */
        post: operations["add_my_api_key_api_me_devices_api_key_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/devices/app-password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Add My App Password
         * @description A device for a Subsonic client: a typeable password instead of a token.
         *
         *     Same as ``POST /api/me/devices`` (the caller's own account, listed and
         *     revoked like any device), except that ``token`` is short enough to type
         *     into a phone (``xxxx-xxxx-xxxx-xxxx``) and a copy is kept encrypted, because
         *     Subsonic's token auth needs the secret itself (``domains/subsonic/``).
         */
        post: operations["add_my_app_password_api_me_devices_app_password_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/devices/{device_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Revoke My Device
         * @description Sign one of the caller's own machines out. 404 if it is not theirs.
         *
         *     The answers a client branches on:
         *
         *     ``200``  gone. ⚠ ``signedOutThisDevice`` says whether the credential just
         *              destroyed is the one this request used — supported and normal ("log
         *              this phone out"), but every following request is a 401, and a
         *              client that did not expect it would render its own logout as a
         *              server fault.
         *     ``404``  no such device **on this account**. A device belonging to somebody
         *              else answers the same way on purpose: distinguishing "not yours"
         *              from "does not exist" would let any member enumerate the
         *              household's device ids one guess at a time.
         *     ``422``  it is the account's only device. See
         *              :class:`~app.domains.accounts.identity.LastDeviceError` — nothing could undo
         *              it, because adding a device requires a working credential *for that
         *              account*, so the account's library and playlists would be stranded
         *              under an id nobody can present. Removing the person is a separate,
         *              deliberate, owner-only act: ``DELETE /api/users/{id}``.
         *     ``409``  the caller is a sentinel and has no account at all.
         */
        delete: operations["revoke_my_device_api_me_devices__device_id__delete"];
        options?: never;
        head?: never;
        /**
         * Rename My Device
         * @description Rename one of the caller's devices, including the current device.
         */
        patch: operations["rename_my_device_api_me_devices__device_id__patch"];
        trace?: never;
    };
    "/api/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Login
         * @description Sign in with a username and a password; get a device token back.
         *
         *     The recovery path, and the second door into a server for a client holding
         *     nothing. ``POST /api/me/devices`` can only add a machine to an account that
         *     already has a signed-in one, so before this existed a household that lost
         *     every device lost the library — see ``app/domains/accounts/identity.py``.
         *
         *     The response is a :class:`CreateDeviceResponse`, byte-identical to
         *     ``POST /api/me/devices``, so a client has exactly one code path for "I now
         *     hold a token" and one place that stores it. ⚠ The rule that comes with that
         *     shape comes with it here too: ``token`` exists in this response and nowhere
         *     else, ever.
         *
         *     ``201`` and not ``200``: this creates a device. It is visible in
         *     ``GET /api/me/devices`` the moment it answers and revocable like any other,
         *     which is what makes a forgotten sign-in on somebody else's laptop
         *     recoverable.
         *
         *     The answers:
         *
         *     ``201``  signed in. ``device`` is the new row, ``token`` its credential.
         *     ``401``  ⚠ wrong username **or** wrong password, indistinguishably. Same
         *              status, same body, and the same ~75 ms of key derivation either way
         *              — ``passwords.verify_password`` runs a full scrypt derivation even
         *              when there is no account to check against, because a fast miss and
         *              a slow hit is a username oracle anybody on the LAN can read with a
         *              stopwatch. Never make this branch cheaper.
         *     ``429``  too many failed sign-ins lately, household-wide; ``Retry-After``
         *              says how long. Global rather than per-account on purpose — a
         *              per-account bucket answers "that name exists" all by itself, and
         *              lets one stranger lock one named person out. See
         *              ``app/core/throttle.py``.
         *     ``422``  the body was not a body (pydantic). Shape only, never content: a
         *              username that could not possibly be valid still gets the 401.
         *
         *     Public (``PUBLIC_EXACT_PATHS``): a caller with no credential is the entire
         *     point, exactly as for ``POST /api/claim``. Unlike the claim, this one does
         *     not close — it is a permanent unauthenticated route that mints credentials,
         *     which is why the throttle above is not optional and why the failure says
         *     nothing.
         */
        post: operations["login_api_login_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/devices/{device_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Revoke User Device
         * @description An owner may revoke one device of another account.
         */
        delete: operations["revoke_user_device_api_users__user_id__devices__device_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/username": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set My Username
         * @description Choose the name this account signs in with, or change it.
         *
         *     ⚠ **This is how an account that predates password sign-in becomes
         *     recoverable**, and it is why it takes no password: every account in an
         *     existing ``users.json`` has neither a username nor a password, and a route
         *     that asked for the current one would have nothing to ask. The credential
         *     that authorizes it is the device token the request arrived with, which is
         *     strictly stronger — it is what a password exists to mint.
         *
         *     The account is the caller's, always, read off the principal and never off
         *     the body.
         *
         *     ``200``  set. ``username`` is the name **as stored**, keeping the case typed.
         *     ``409``  somebody in this household already has it. That does reveal the
         *              name exists, and it is the right trade: the caller lives with these
         *              people, and the alternative is a rename that silently did not
         *              happen.
         *     ``422``  not a usable name; the message says what a name may contain.
         */
        post: operations["set_my_username_api_me_username_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/label": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set My Label
         * @description Rename the caller's own account — what the household calls you.
         *
         *     ⚠ Not the username and not a device. Three names live on an account and
         *     this is the middle one: ``username`` is what you type to sign in
         *     (``/me/username``), ``label`` is what every list shows for you, and each
         *     device has a label of its own. The first account on a server was claimed
         *     from a phone and ``create_user`` names the account after its first device,
         *     so without this route the owner of every household is called «Robin
         *     (iPhone)» forever, on every client.
         *
         *     Account off the principal, never off the body. ``409`` for a principal with
         *     no row, like every ``/me`` route; ``422`` for a blank name.
         */
        post: operations["set_my_label_api_me_label_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Change My Password
         * @description Set or change the password on the caller's own account.
         *
         *     ⚠ **This does not sign any other device out, and that is a decision rather
         *     than an omission.** The two answers pull opposite ways and both are
         *     reasonable, so the reasoning is written down:
         *
         *     *The security-obvious answer is to revoke.* On most systems a password is
         *     the session: changing it because you fear compromise should end every
         *     session it created, or the change accomplished nothing.
         *
         *     *The user-obvious answer is not to.* Here the password is **not** the
         *     session. Device tokens are, they were minted individually, and each one is
         *     listed and revocable by itself in ``GET /api/me/devices``. Somebody raising
         *     a weak password — the routine, desirable act — has no reason to expect that
         *     the family's other phone, the laptop and the tablet all stop working, and
         *     every one of them would then have to be signed in again by hand.
         *
         *     The deciding argument is that revoking here would make the *routine* action
         *     destructive while adding nothing the household did not already have: the
         *     action for "a device is stolen" exists, is precise, and is one call away.
         *     Bundling the two makes the precise tool feel redundant and the routine one
         *     frightening, and a frightening password change is a password that never gets
         *     changed.
         *
         *     ⚠ The honest cost, stated in the response as well as here: if the *password
         *     itself* leaked and somebody already spent it on ``POST /api/login``, changing
         *     it does **not** evict them — they hold a device token now, and tokens do not
         *     care about passwords. ``otherDevicesSignedOut: false`` and ``deviceCount``
         *     exist so a client can say exactly that and send the user to the device list,
         *     which is where evicting somebody actually happens.
         *
         *     Not throttled, unlike ``POST /api/login``: guessing the current password
         *     here requires already holding a working device token for this account, and a
         *     caller who has that has everything the password could get them. There is
         *     nothing to escalate to, so a limiter would only give one member a way to
         *     interfere with another.
         *
         *     ``200``  changed.
         *     ``401``  the current password is wrong. Same wording as a failed sign-in.
         *     ``409``  no username yet — a password with no username can never sign in, so
         *              it is refused rather than stored as a credential that does nothing.
         *     ``422``  the new password is shorter than the floor
         *              (``passwords.MIN_PASSWORD_LENGTH``); the message says the floor and
         *              nothing about composition, because there are no composition rules.
         */
        post: operations["change_my_password_api_me_password_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/claim": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Claim Server
         * @description Create the first owner of a server that has none. Once, ever.
         *
         *     The response is a :class:`CreateUserResponse`, byte-identical in shape to
         *     ``POST /api/users`` — reused rather than reinvented so a client decodes the
         *     minted credential with the code it already has, and so ⚠ the rule that a
         *     token is shown exactly once and never recoverable applies here unchanged.
         *
         *     ``username`` and ``password`` are optional and, when given, make the first
         *     account recoverable from the moment it exists — the household that has just
         *     claimed a server is precisely the one whose whole access is a single token on
         *     a single phone. ⚠ They are additive rather than required because a shipped
         *     desktop client posts ``{label}`` alone; see :class:`ClaimRequest`. The
         *     **response shape does not change either way**: ``{user, token}`` with the
         *     same five keys under ``user``, pinned by
         *     ``tests/integration/test_response_contracts.py`` and decoded by two clients.
         *
         *     The answers, all of which a client is expected to branch on:
         *
         *     ``201``  claimed. ``token`` is the owner credential and this is the only
         *              moment it exists anywhere.
         *     ``409``  already set up. The normal answer forever after the first success,
         *              and the reason this is not a 500: a second client racing the first,
         *              or a user re-running a setup screen, is not a server fault.
         *     ``401``  a setup token is required and the one presented was wrong or
         *              missing. Only reachable in strict mode.
         *     ``429``  too many rejected setup tokens lately; ``Retry-After`` says how long.
         *     ``422``  no usable label (pydantic, same as ``POST /api/users``), or a
         *              username/password pair that was half-given, malformed or too short.
         *              ⚠ Nothing is created in that case: the credentials are validated
         *              and hashed before the store's lock is taken, so a rejected pair
         *              cannot leave a half-claimed server behind.
         *
         *     ⚠ The ``has_users`` check below is a **courtesy, not the guard**. It exists
         *     so an already-claimed server answers 409 without making the caller produce a
         *     setup token it has no way to obtain. The guarantee that exactly one caller
         *     wins lives in ``store.claim_first_owner``, which does the check and the mint
         *     under one lock; the ``AlreadyInitializedError`` branch here is the loser of
         *     that race, and it must stay even though the early check "already covers it".
         *
         *     Order matters: the credential check runs before the write, so a wrong setup
         *     token cannot create anything, and the throttle runs before the credential
         *     check, so a brute force pays its cost before any comparison happens.
         */
        post: operations["claim_server_api_claim_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Users
         * @description Everyone who holds a token — metadata only, never the tokens.
         */
        get: operations["list_users_api_users_get"];
        put?: never;
        /**
         * Create User
         * @description Mint a token. ``token`` in the response is the only time it exists.
         */
        post: operations["create_user_api_users_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List User Devices
         * @description Every device of **one account**, oldest first — owner-only.
         *
         *     The per-account counterpart of ``GET /api/me/devices``: an owner's settings
         *     panel lists the accounts on the server and unfolds each one into its
         *     machines. ⚠ ``/api/users`` itself stays five keys per row
         *     (``tests/integration/test_response_contracts.py`` pins it and two shipped
         *     clients decode it), which is why the devices live on a route of their own
         *     rather than nested in that list.
         *
         *     Same body shape as ``GET /api/me/devices``, ``isCurrent`` included, so a
         *     client renders both with one decoder. It can only be true on the owner's
         *     own account — the credential this request arrived with belongs to exactly
         *     one device of exactly one account — and it is the marker that lets the
         *     panel say "this phone" inside the owner's own row.
         *
         *     Metadata only: nothing here reaches a digest. Unknown account → 404.
         */
        get: operations["list_user_devices_api_users__user_id__devices_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/label": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set User Label
         * @description Rename one account, as its owner sees it in the household list.
         *
         *     The owner-side twin of ``POST /api/me/label``, for the same reason
         *     ``/users/{id}/devices`` exists beside ``/me/devices``: the accounts an owner
         *     minted for other people were also named after a device, and the person
         *     holding that phone may never open their own settings. Metadata only.
         *     Unknown account → 404.
         */
        post: operations["set_user_label_api_users__user_id__label_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/deletion-preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Deletion Preview */
        get: operations["deletion_preview_api_users__user_id__deletion_preview_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Revoke User
         * @description Revoke a token. 422 rather than a silent no-op on the last owner.
         */
        delete: operations["revoke_user_api_users__user_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reset Account Password */
        post: operations["reset_account_password_api_users__user_id__password_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/onboarded": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Complete Account Onboarding */
        post: operations["complete_account_onboarding_api_me_onboarded_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/sign-in-code": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Request Sign In Code */
        post: operations["request_sign_in_code_api_sign_in_code_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/sign-in-code/poll": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Poll Sign In Code */
        post: operations["poll_sign_in_code_api_sign_in_code_poll_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/sign-in-code": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Approve Sign In Code */
        post: operations["approve_sign_in_code_api_me_sign_in_code_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/sign-in-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Sign In Requests */
        get: operations["list_sign_in_requests_api_me_sign_in_requests_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/sign-in-requests/{request_id}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Approve Sign In Request */
        post: operations["approve_sign_in_request_api_me_sign_in_requests__request_id__approve_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/sign-in-requests/{request_id}/decline": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Decline Sign In Request */
        post: operations["decline_sign_in_request_api_me_sign_in_requests__request_id__decline_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/sign-in-code/{code}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Inspect Sign In Code
         * @description Possession of the typed code opens its facts, never approves it.
         */
        get: operations["inspect_sign_in_code_api_me_sign_in_code__code__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/sign-in-code/{code}/decline": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Decline Typed Sign In Code */
        post: operations["decline_typed_sign_in_code_api_me_sign_in_code__code__decline_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/sign-in": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Account Sign In
         * @description What an owner needs before resetting a password: whether the account has a username yet.
         */
        get: operations["account_sign_in_api_users__user_id__sign_in_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/library": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * My Library
         * @description Keep every ownership row on its pinned wire keys.
         *
         *     Owners can inspect a person's library for the Biblioteca scope picker.
         *     Members can only read their own rows; a missing file never removes a row.
         */
        get: operations["my_library_api_me_library_get"];
        put?: never;
        /**
         * Add To My Library
         * @description Claim tracks that already exist in the shared catalog.
         *
         *     **The dedupe hit, and the point of the whole feature.** The bytes are on the
         *     server already, so becoming this user's costs one row: no download, no
         *     yt-dlp, no queue, no wait. Anything not on disk comes back in ``missing``
         *     with a 200 — see the module docstring.
         *
         *     Idempotent: a path the caller already holds lands in ``already`` and its
         *     existing row (``addedAt``, ``liked``, ``playCount``) is left exactly as it
         *     was. Re-adding is not a reset.
         */
        post: operations["add_to_my_library_api_me_library_post"];
        /**
         * Remove From My Library
         * @description Drop this caller's references. **The files stay on disk.**
         *
         *     ⚠ Not ``POST /api/delete-track``. That endpoint unlinks the audio and every
         *     member loses it; this one forgets a row and the same ``POST /api/me/library``
         *     call brings it straight back. Only playlist JSON is rewritten; shared
         *     audio is never removed by this operation.
         *
         *     Paths the caller does not hold are simply absent from ``removed``, so a
         *     retried DELETE is harmless.
         */
        delete: operations["remove_from_my_library_api_me_library_delete"];
        options?: never;
        head?: never;
        /**
         * Patch My Row
         * @description Set ``liked`` / ``offline`` on one row. Absent or null leaves it alone.
         *
         *     404 when the caller holds no such row: liking a track you have not added is
         *     meaningless, and upserting here would be a second add verb — one that skips
         *     the on-disk check ``POST /api/me/library`` exists to do.
         */
        patch: operations["patch_my_row_api_me_library_patch"];
        trace?: never;
    };
    "/api/me/library/missing": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Missing Library
         * @description List the account's owned paths whose files are gone; owner or self only.
         */
        get: operations["missing_library_api_me_library_missing_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/plays": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record Play */
        post: operations["record_play_api_me_plays_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/plays/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Play History
         * @description Export the calling owner's history, including missing and removed songs.
         *
         *     Bounds are timezone-aware instants: inclusive from, exclusive to.
         *     Follow nextCursor as after for the next page, retaining the same bounds.
         */
        get: operations["play_history_api_me_plays_history_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/library/ownership": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Check My Ownership
         * @description Which of these does the caller already hold?
         *
         *     **Answers positionally**, the same convention as ``POST /api/library/ownership``
         *     in ``domains/music/routes.py``: ``results[i]`` is the verdict for
         *     ``relPaths[i]``, always, and the list is never filtered or reordered — a
         *     client drawing ownership markers by index would draw them on the wrong rows.
         *     ``relPath`` is echoed on each result so a misalignment is detectable rather
         *     than silent.
         *
         *     Note the two ownership endpoints answer different questions and both are
         *     needed: the one in ``music`` asks whether the *library* has a catalog track
         *     (fuzzy, by title/artist), this one asks whether *you* have a known file
         *     (exact, by ``relPath``).
         *
         *     Repeats are answered in place rather than de-duplicated — positional means
         *     positional.
         */
        post: operations["check_my_ownership_api_me_library_ownership_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Health
         * @description Cheap unauthenticated liveness/readiness probe.
         *
         *     The desktop client polls this before opening its window, which matters most
         *     when the backend is remote: a reachable port is not proof the app is usable.
         *     The extra fields make a remote deployment debuggable without shell access —
         *     which music root the server actually resolved (it is the *server's* path, not
         *     the client's) and whether ffmpeg exists there (no ffmpeg means downloads and
         *     the audio editor fail later, in a much more confusing way).
         */
        get: operations["health_api_health_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/extensions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Extensions */
        get: operations["list_extensions_api_extensions_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Server Status
         * @description The handshake: *who are you, and how do I talk to you?*
         *
         *     ``/api/health`` answers "something is alive here". That was never enough for
         *     the question the desktop client actually has when it finds port 8000 busy:
         *     is that **my** server, a second copy of me, or an orphan from a crash? It
         *     used to answer by starting another server on the next free port, so two
         *     processes ended up writing the same library and no request could say which
         *     one it had reached.
         *
         *     ``instanceId`` ends that. It names the *data directory*, survives restarts
         *     and a change of port, and lets a client that recorded it adopt a running
         *     server instead of spawning a rival. See ``app/core/instance.py``.
         *
         *     ``name`` is what this server is called — «el nido» in the clients' words:
         *     the name set at claim time or by an owner (``PUT /api/server/name``), else
         *     ``Nido de <hostname>``. ⚠ Never an account label: this body is public and
         *     names nobody (see ``app/core/instance.py``).
         *
         *     ``isInit`` tells a fresh client whether this household has anybody in it yet,
         *     so it can offer "claim this server" instead of an unexplained 401 — the
         *     first-run state is a normal state, not an error. ``POST /api/claim`` is what
         *     that offer leads to, and ``setupTokenRequired`` (below) says whether the
         *     setup screen has to ask for a secret first.
         *
         *     ⚠ **Additive only.** An iOS client and a desktop client are built against
         *     this body and pinned by ``tests/integration/test_response_contracts.py``. A
         *     new key is free; a renamed or removed one breaks a shipped app that cannot
         *     be updated in step with the server it points at.
         *
         *     Unauthenticated on purpose (``PUBLIC_EXACT_PATHS``): a client must be able to
         *     ask who this is *before* it holds any credential. That constraint is also why
         *     the payload is deliberately thin — nothing here describes the library, and
         *     the nest's other addresses live on the authenticated ``/api/server/network``.
         *
         *     CORS follows the configured allow list for Tauri and Vite dev origins.
         */
        get: operations["server_status_api_status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/server/setup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set Setup State
         * @description Mark the first-run wizard finished (or not). Owner-only.
         *
         *     Kept on the server, not in a client: the wizard runs once per nest, and a
         *     second computer or a browser joining a set-up nest must not run it again.
         */
        put: operations["set_setup_state_api_server_setup_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Library Summary
         * @description What the library holds, counted: the first-run wizard's music step.
         *
         *     One scan, the same memoized one the listing uses. ``artists`` counts album
         *     artists, case- and accent-insensitively.
         */
        get: operations["library_summary_api_library_summary_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/server/name": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set Server Name
         * @description Rename the nest. Owner-only.
         *
         *     The name lives beside the instance id in ``instance.json`` and is served by
         *     ``GET /api/status`` and the LAN advertisement, which is re-registered here so
         *     other machines see the new name without a restart. ``422`` for an empty,
         *     over-long (> 60) or control-character name.
         */
        put: operations["set_server_name_api_server_name_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/server/network": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Server Network
         * @description Every address this nest can be reached at: local, Tailscale, domain.
         *
         *     Clients refresh their copy on every successful connection and, when the
         *     address they were set up with stops answering, try the others in order
         *     (``contracts/remote-access.json`` → ``pick``), keeping whichever answers
         *     ``/api/status`` with this nest's ``instanceId``. See
         *     ``app/core/remote_access.py``.
         *
         *     Any signed-in principal, members included: a member's phone away from home
         *     needs the Tailscale address exactly as much as the owner's does.
         *
         *     ⚠ **Deliberately not on ``/api/status``** and not in ``PUBLIC_EXACT_PATHS``.
         *     The handshake answers anyone who can reach the port; the domain, the
         *     tailnet name and the list of interfaces together are a map of where this
         *     deployment lives. A client only needs them once it holds a credential.
         */
        get: operations["server_network_api_server_network_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/server/remote-route": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Set Remote Route */
        put: operations["set_remote_route_api_server_remote_route_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/server/host": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Server Host
         * @description Owner-only deployment facts; unavailable probes remain null.
         */
        get: operations["server_host_api_server_host_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/server/storage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Server Storage
         * @description The data disk, split: music · stems · the rest, in bytes. Owner-only.
         *
         *     ``disk`` is ``shutil.disk_usage`` of the resolved data root; ``music`` and ``stems`` are summed by a
         *     walk cached ~5 min (``storage.py``); ``other`` is used − music − stems,
         *     floored at 0. Owner-only like the rest of the nest's admin: a member has no
         *     use for the server's disk and its size is a deployment fingerprint.
         */
        get: operations["server_storage_api_server_storage_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/server/external-url": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set External Url
         * @description Store the HTTPS domain in front of this nest. Owner-only.
         *
         *     Normalised by ``remote_access.normalise_external_url`` — the server is
         *     authoritative and runs the shared contract cases. ``422`` with ``detail``
         *     = the bare reason code (``needs-https``, ``has-path``, ``has-credentials``,
         *     ``not-a-url``), never prose: each client maps the code to its own words.
         *
         *     The server does not probe the domain. Checking it is the client's job,
         *     from where the person is — a domain checked from inside the LAN can fail on
         *     hairpin NAT and still work outside, which is why an owner may save one that
         *     did not answer.
         */
        put: operations["set_external_url_api_server_external_url_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ping": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Ping
         * @description Reachability check that leaves a trace in the log.
         *
         *     Exists purely for the human debugging "can this machine even reach the
         *     backend?". ``/api/health`` deliberately stays silent and allocation-cheap
         *     because clients poll it in a loop — logging a line per poll would bury every
         *     other message in the file. This one is only ever hit by hand, so it can
         *     afford to say it was hit, which is the entire point: the answer arrives in
         *     the log the user is already reading rather than only in a terminal they may
         *     not have.
         */
        get: operations["ping_api_ping_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/set-basedir": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Set Basedir */
        post: operations["set_basedir_api_set_basedir_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/get-basedir": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Basedir */
        get: operations["get_basedir_api_get_basedir_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/get-default-basedir": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Default Basedir */
        get: operations["get_default_basedir_api_get_default_basedir_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/reset-basedir": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reset Basedir */
        post: operations["reset_basedir_api_reset_basedir_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/config/spotify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Spotify Config
         * @description Return whether Spotify credentials are configured (no secrets).
         */
        get: operations["get_spotify_config_api_config_spotify_get"];
        /**
         * Put Spotify Config
         * @description Compatibility settings route, backed by the nest's secret store.
         */
        put: operations["put_spotify_config_api_config_spotify_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/config/ytdlp-cookies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Ytdlp Cookies Config
         * @description Current source cookie settings (not secret — just a browser name / path).
         */
        get: operations["get_ytdlp_cookies_config_api_config_ytdlp_cookies_get"];
        /**
         * Put Ytdlp Cookies Config
         * @description Persist source cookies to the nest's settings file and apply them live.
         *
         *     Takes effect immediately for new downloads (the repository reads config at
         *     call time); the .env write makes it survive restarts.
         */
        put: operations["put_ytdlp_cookies_config_api_config_ytdlp_cookies_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/config/analysis-tags": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Analysis Tags Config
         * @description Whether detected BPM/key are written back into music files (opt-in).
         */
        get: operations["get_analysis_tags_config_api_config_analysis_tags_get"];
        /**
         * Put Analysis Tags Config
         * @description Persist the tag write-back toggle to <root>/.env and apply it live.
         *
         *     Takes effect immediately (background analysis reads config at run time); the
         *     .env write makes the choice survive restarts.
         */
        put: operations["put_analysis_tags_config_api_config_analysis_tags_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/open-file": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Open File */
        post: operations["open_file_api_open_file_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/logs/clear": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Clear Logs
         * @description Clear the current allowlisted log in place, preserving rotated files.
         */
        post: operations["clear_logs_api_logs_clear_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/logs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read Logs
         * @description Tail a backend log.
         *
         *     Powers Ajustes → Registro. Deliberately read-only and allowlisted: `file` is
         *     a key into LOG_FILES, never a path fragment.
         *
         *     `errors` is JSON per line and `app` is prose, so the shape of a record
         *     differs; both are returned as raw text plus a best-effort parse, and the UI
         *     renders whichever it got. Filtering happens here rather than in the browser
         *     because the whole point is to avoid shipping megabytes to it.
         */
        get: operations["read_logs_api_logs_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/server/secrets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Status */
        get: operations["status_api_server_secrets_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/server/secrets/key/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Export Key */
        post: operations["export_key_api_server_secrets_key_export_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/server/secrets/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Put */
        put: operations["put_api_server_secrets__name__put"];
        post?: never;
        /** Delete */
        delete: operations["delete_api_server_secrets__name__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/server/config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Config */
        get: operations["config_api_server_config_get"];
        /** Update */
        put: operations["update_api_server_config_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/server/restart": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Restart */
        post: operations["restart_api_server_restart_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/server/update": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read Update */
        get: operations["read_update_api_server_update_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/server/update/check": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Check Update */
        post: operations["check_update_api_server_update_check_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/server/update/skip": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Skip Update */
        put: operations["skip_update_api_server_update_skip_put"];
        post?: never;
        /** Restore Update */
        delete: operations["restore_update_api_server_update_skip_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/server/backups": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Backups */
        get: operations["list_backups_api_server_backups_get"];
        put?: never;
        /** Backup Now */
        post: operations["backup_now_api_server_backups_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Root */
        get: operations["root__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/home": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Home Snapshot */
        get: operations["home_snapshot_api_me_home_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** AcquireRequest */
        AcquireRequest: {
            /** Tracks */
            tracks: components["schemas"]["AcquireTrack"][];
            /** Folder */
            folder?: string | null;
            /** Label */
            label?: string | null;
        };
        /**
         * AcquireTrack
         * @description One catalog track to acquire.
         *
         *     Deliberately mirrors what a browse tracklist already renders, so the client
         *     forwards the rows it has rather than re-deriving them. Every field here
         *     exists because the download pipeline needs it:
         *
         *     * ``title``/``artistName`` — the search identity and the ID3 tags;
         *     * ``albumTitle`` — decides the destination folder and the cover-beside-track
         *       convention;
         *     * ``durationSeconds`` — the only thing arming ``DURATION_VETO_S``, which is
         *       what refuses a live take or an extended mix of the right title;
         *     * ``trackPosition`` — the filename prefix and the track tag;
         *     * ``coverUrl`` — embedded as artwork, after being upgraded to the provider's
         *       full-size variant here. The client sends back the display-size URL it was
         *       given, because that is the row it already has; it does not have to know
         *       that a library file wants a bigger image than a card does.
         */
        AcquireTrack: {
            /** Title */
            title: string;
            /** Artistname */
            artistName?: string | null;
            /** Albumtitle */
            albumTitle?: string | null;
            /** Trackposition */
            trackPosition?: number | null;
            /** Durationseconds */
            durationSeconds?: number | null;
            /** Coverurl */
            coverUrl?: string | null;
            /** Isrc */
            isrc?: string | null;
            /** Replaces */
            replaces?: string | null;
        };
        /** Action */
        Action: {
            /** Id */
            id: string;
            /** Label */
            label: string;
        };
        /** ActionView */
        ActionView: {
            /** Id */
            id: string;
            /** Attempt */
            attempt: number;
        };
        /** Activity */
        Activity: {
            /** Downloads */
            downloads: number;
            /** Jobs */
            jobs: number;
            /** Devicesseen5Min */
            devicesSeen5min: number;
        };
        /**
         * AddDeviceRequest
         * @description ``POST /api/me/devices``.
         *
         *     There is no ``userId``: the account always comes from the caller.
         *     ``helper`` optionally enrolls a processing device (owners only); an absent
         *     flag also recognizes the desktop's historical worker label. The account comes
         *     from the credential the request arrived with, so a body cannot aim a freshly
         *     minted token at somebody else's library. Same limits as
         *     :class:`CreateUserRequest` so a client reuses its validation.
         */
        AddDeviceRequest: {
            /** Label */
            label: string;
            /** Helper */
            helper?: boolean | null;
        };
        /**
         * AddToLibraryResponse
         * @description ``POST /api/me/library`` — 200 even when some paths are not on disk.
         *
         *     Three disjoint buckets over the paths that were sent: ``added`` is new rows,
         *     ``already`` is rows the caller had (untouched — re-adding is not a reset),
         *     and ``missing`` is paths the shared catalog does not hold. ⚠ ``missing`` is
         *     not an error and must not be rendered as one; failing the batch because one
         *     of fifty tracks is absent would make the dedupe hit hostage to the miss.
         */
        AddToLibraryResponse: {
            /** Added */
            added: string[];
            /** Already */
            already: string[];
            /** Missing */
            missing: string[];
        };
        /** AgentByeRequest */
        AgentByeRequest: {
            /** Id */
            id?: string | null;
            /** Sessionid */
            sessionId?: string | null;
            /**
             * Reason
             * @default quit
             * @enum {string}
             */
            reason: "quit" | "sleep";
        };
        /** AgentClaimRequest */
        AgentClaimRequest: {
            agent: components["schemas"]["AgentIdentity"];
            /**
             * Max
             * @default 1
             */
            max: number;
        };
        /** AgentControlResponse */
        AgentControlResponse: {
            /** Stop */
            stop: boolean;
            /** Reason */
            reason?: ("replaced" | "lease-lost" | "cancelled" | "revoked" | "too-old") | null;
            /** Minimum */
            minimum?: string | null;
        };
        /** AgentHeartbeatRequest */
        AgentHeartbeatRequest: {
            agent?: components["schemas"]["AgentIdentity"] | null;
            /**
             * Lease
             * @default
             */
            lease: string;
            /**
             * Jobid
             * @default
             */
            jobId: string;
            /** Phase */
            phase?: string | null;
            /** Percent */
            percent?: number | null;
        };
        /** AgentIdentity */
        AgentIdentity: {
            /** Id */
            id?: string | null;
            /** Name */
            name: string;
            /** Sessionid */
            sessionId?: string | null;
            /**
             * Platform
             * @default
             */
            platform: string;
            /**
             * Os
             * @default macos
             * @enum {string}
             */
            os: "macos" | "windows" | "linux";
            /**
             * Accel
             * @default mlx
             * @enum {string}
             */
            accel: "mlx" | "cuda" | "cpu";
            /** Gpu */
            gpu?: string | null;
            /** Chip */
            chip?: string | null;
            /** Memorybytes */
            memoryBytes?: number | null;
            /** Jobs */
            jobs?: ("align" | "transcribe" | "stems" | "analysis")[];
            /** Labels */
            labels?: string[];
            /**
             * Keepawake
             * @default none
             * @enum {string}
             */
            keepAwake: "held" | "failed" | "none";
            /** Macos */
            macos?: string | null;
            /**
             * Version
             * @default
             */
            version: string;
            /** Utcoffsetminutes */
            utcOffsetMinutes?: number | null;
            /** Engines */
            engines?: {
                [key: string]: components["schemas"]["EngineInventory"];
            } | null;
            /** Onbattery */
            onBattery?: boolean | null;
            /** Powerreadable */
            powerReadable?: boolean | null;
            /** Pausedreason */
            pausedReason?: ("thermal" | "battery" | "hours" | "paused" | "off") | null;
            /**
             * State
             * @default idle
             */
            state: string;
            /** Lasterror */
            lastError?: ("network-denied" | "token-rejected" | "nest-unreachable") | null;
        };
        /** AgentResultRequest */
        AgentResultRequest: {
            /** Lease */
            lease: string;
            /** Jobid */
            jobId: string;
            /** Ok */
            ok: boolean;
            /** Lrc */
            lrc?: string | null;
            /** Source */
            source?: string | null;
            /** Error */
            error?: string | null;
            /**
             * Final
             * @default true
             */
            final: boolean;
            /** Accel */
            accel?: ("mlx" | "cuda" | "cpu") | null;
            /** Fallbackreason */
            fallbackReason?: ("oom" | "driver") | null;
            /** Gpu */
            gpu?: string | null;
            /** Lineconfidence */
            lineConfidence?: number[] | null;
            /** Lowlines */
            lowLines?: number[] | null;
        };
        /**
         * AlbumNamesResponse
         * @description ``GET /api/listar-albums`` — display names only, nothing else.
         */
        AlbumNamesResponse: {
            /** Albums */
            albums: string[];
        };
        /** AlbumUrlRequest */
        AlbumUrlRequest: {
            /** Url */
            url: string;
        };
        /**
         * AlbumWithMetadata
         * @description One album in ``GET /api/listar-albums-con-metadata``.
         *
         *     ``cover`` is a ``data:`` URI when ``covers=true`` (the default, kept only for
         *     the desktop renderer) and ``null`` when ``covers=false`` or the album has no
         *     artwork. Same key either way — the flag changes the value, never the shape.
         *     ``coverVersion`` is the cover's mtime/size revision (or null if missing),
         *     usable as ``cover.jpg?size=96&v=<coverVersion>`` for immutable caching.
         */
        AlbumWithMetadata: {
            /** Album */
            album: string;
            /** Artist */
            artist: string;
            /** Path */
            path: string;
            /** Mediakey */
            mediaKey?: string | null;
            /** Year */
            year?: number | null;
            /** Genre */
            genre?: string | null;
            /** Albumartist */
            albumArtist?: string | null;
            /**
             * Compilation
             * @default false
             */
            compilation: boolean;
            /** Genres */
            genres?: string[];
            /** Albumsort */
            albumSort?: string | null;
            /** Albumartistsort */
            albumArtistSort?: string | null;
            /** Cover */
            cover?: string | null;
            /** Coverversion */
            coverVersion?: string | null;
            /** Duration */
            duration?: number | null;
            /** Tracks */
            tracks: components["schemas"]["TrackWithMetadata"][];
        };
        /** AlignLyricsRequest */
        AlignLyricsRequest: {
            /** Album */
            album: string;
            /** File */
            file: string;
            restore?: components["schemas"]["RestoreLyricsMetadata"] | null;
            /**
             * Kind
             * @default plain
             */
            kind: string;
            /**
             * Text
             * @default
             */
            text: string;
            /**
             * Source
             * @description lrclib | genius | manual | file | stt:…
             * @default manual
             */
            source: string;
            /** Providerref */
            providerRef?: string | null;
            /**
             * Edited
             * @default false
             */
            edited: boolean;
            /**
             * Force
             * @default false
             */
            force: boolean;
            /**
             * Expectedrevision
             * @description Conditional save: last read revision; empty string means no lyric
             */
            expectedRevision?: string | null;
        };
        /** AnalysisSummary */
        AnalysisSummary: {
            /**
             * Outdated
             * @default 0
             */
            outdated: number;
            estimated: components["schemas"]["EstimatedCounts"];
            /** Total */
            total: number;
            /** Analyzed */
            analyzed: number;
            /** Queued */
            queued: number;
            /** Failed */
            failed: number;
            /** Engineversion */
            engineVersion: number;
            helper: components["schemas"]["SummaryHelper"];
            /**
             * Waiting
             * @default 0
             */
            waiting: number;
            run?: components["schemas"]["RunProgress"] | null;
        };
        /** AnalysisTagsRequest */
        AnalysisTagsRequest: {
            /**
             * Write Analysis Tags
             * @default false
             */
            write_analysis_tags: boolean;
        };
        /** AnalysisView */
        AnalysisView: {
            /** Keyconfidence */
            keyConfidence?: number | null;
            /** Bpmconfidence */
            bpmConfidence?: number | null;
            key: components["schemas"]["EffectiveValue"];
            bpm: components["schemas"]["EffectiveValue"];
            /** Mood */
            mood: string | null;
            /** Energy */
            energy: number | null;
            /** Brightness */
            brightness: number | null;
            /** Pulse */
            pulse: number | null;
            /** Arousal */
            arousal?: number | null;
            computed: components["schemas"]["ComputedValues"];
            fixed: components["schemas"]["Values"];
            /** Rev */
            rev: number;
            /**
             * State
             * @enum {string}
             */
            state: "analyzed" | "queued" | "failed" | "none";
        };
        /** ApproveSignInCodeRequest */
        ApproveSignInCodeRequest: {
            /** Code */
            code: string;
        };
        /** AttentionHelper */
        AttentionHelper: {
            /** Id */
            id: string;
            /** Name */
            name: string;
            /**
             * State
             * @enum {string}
             */
            state: "working" | "idle" | "asleep" | "closed" | "offline" | "outdated" | "revoked";
            /** Version */
            version: string;
            /** Waiting */
            waiting: number;
            /** Lastseenat */
            lastSeenAt?: number | null;
            /** Minimumversion */
            minimumVersion?: string | null;
            progress?: components["schemas"]["AttentionProgress"] | null;
        };
        /** AttentionProgress */
        AttentionProgress: {
            /** Done */
            done: number;
            /** Total */
            total: number;
        };
        /** AttentionResponse */
        AttentionResponse: {
            version?: components["schemas"]["AttentionVersion"] | null;
            helper?: components["schemas"]["AttentionHelper"] | null;
            /**
             * Helpers
             * @default 0
             */
            helpers: number;
            /** Flag */
            flag?: ("version" | "helper") | null;
            /** Flagtone */
            flagTone?: ("info" | "warn" | "bad") | null;
        };
        /** AttentionVersion */
        AttentionVersion: {
            /** Latest */
            latest: string;
            /** Current */
            current: string;
            /** Skipped */
            skipped: string | null;
            /** Show */
            show: boolean;
        };
        /** BackupEntry */
        BackupEntry: {
            /** Stamp */
            stamp: string;
            /** Size */
            size: number;
            /** Reason */
            reason: string;
            /** Ok */
            ok: boolean;
        };
        /** BackupsResponse */
        BackupsResponse: {
            /** Backups */
            backups: components["schemas"]["BackupEntry"][];
        };
        /** BaseDirRequest */
        BaseDirRequest: {
            /** Basedir */
            basedir: string;
        };
        /** Batch */
        Batch: {
            /** Files */
            files: components["schemas"]["UploadFile"][];
            /** Id */
            id: string;
        };
        /** BatchPlay */
        BatchPlay: {
            /** Startedat */
            startedAt?: string | null;
            /** Playedseconds */
            playedSeconds?: number | null;
            /**
             * Completed
             * @default true
             */
            completed: boolean;
            /** Source */
            source?: ("desktop" | "phone") | null;
            /** Trackkey */
            trackKey: string;
            /**
             * Listenedat
             * Format: date-time
             */
            listenedAt: string;
            /** Clientplayid */
            clientPlayId: string;
        };
        /** BatchResult */
        BatchResult: {
            /** Editid */
            editId: string;
            /** Progressid */
            progressId: string;
        };
        /** BatchView */
        BatchView: {
            /** Files */
            files: components["schemas"]["UploadItemView"][];
            /** Maxbytes */
            maxBytes: number;
            /** Id */
            id: string;
            /**
             * Phase
             * @enum {string}
             */
            phase: "resumen" | "subiendo" | "terminado";
        };
        /** Body_open_file_api_open_file_post */
        Body_open_file_api_open_file_post: {
            /** Path */
            path: string;
        };
        /** Body_stems_agent_result_api_stems_agent_result_post */
        Body_stems_agent_result_api_stems_agent_result_post: {
            /**
             * Id
             * @description The lease id from claim
             */
            id: string;
            /**
             * Ok
             * @default true
             */
            ok: boolean;
            /** Error */
            error?: string | null;
            /**
             * Final
             * @description A failure that is a verdict about the song, not an accident
             * @default false
             */
            final: boolean;
            /** Song.Json */
            "song.json"?: string | null;
            /** Drums */
            drums?: string | null;
            /** Bass */
            bass?: string | null;
            /** Vocals */
            vocals?: string | null;
            /** Other */
            other?: string | null;
        };
        /** Cancion */
        Cancion: {
            /** Title */
            title: string;
            /** Track Number */
            track_number: number;
        };
        /** CandidateResponse */
        CandidateResponse: {
            /** Provider */
            provider: string;
            /** Providerref */
            providerRef?: string | null;
            /** Url */
            url?: string | null;
            /** Title */
            title: string;
            /** Artist */
            artist: string;
            /** Album */
            album: string;
            /** Durationseconds */
            durationSeconds?: number | null;
            /** Durationdeltaseconds */
            durationDeltaSeconds?: number | null;
            /** Overrunseconds */
            overrunSeconds?: number | null;
            /** Withintolerance */
            withinTolerance: boolean;
            /** Kind */
            kind: string;
            /** Instrumental */
            instrumental: boolean;
            /** Linecount */
            lineCount: number;
            /** Preview */
            preview: string[];
            /** Text */
            text: string;
        };
        /** ChangeEvent */
        ChangeEvent: {
            /** Area */
            area: string;
            /** Rev */
            rev: number | string;
            /** Ids */
            ids?: string[] | null;
        };
        /**
         * ChangePasswordRequest
         * @description ``POST /api/me/password``.
         *
         *     ``currentPassword`` is optional **in the schema** and required by the store
         *     whenever there is one to check — see ``TokenStore.set_password`` for why an
         *     account that never had a password cannot be asked for it, and why that is
         *     not a bypass. A client should send it whenever it has it; sending one to an
         *     account that has none is ignored, not refused.
         */
        ChangePasswordRequest: {
            /** Currentpassword */
            currentPassword?: string | null;
            /** Newpassword */
            newPassword: string;
        };
        /** Check */
        Check: {
            /** Files */
            files: components["schemas"]["UploadFile"][];
        };
        /** CheckView */
        CheckView: {
            /** Files */
            files: components["schemas"]["UploadItemView"][];
            /** Maxbytes */
            maxBytes: number;
        };
        /**
         * ClaimRequest
         * @description ``POST /api/claim``.
         *
         *     ``label`` is what the owner's row will be called, exactly as in
         *     ``CreateUserRequest`` — same field, same limits, so a client can reuse its
         *     validation. There is no ``role``: the first account is an owner or the claim
         *     achieved nothing (see ``TokenStore.claim_first_owner``).
         *
         *     ``username`` and ``password`` create the first account already recoverable,
         *     which is the point: the household that has just claimed a server is the one
         *     with exactly one device holding exactly one token, and losing that phone
         *     before setting a password is how somebody ends up locked out of a library
         *     they own. ⚠ They are nevertheless **optional and additive**, because a
         *     desktop client shipped before this feature posts ``{label}`` and nothing
         *     else — a claim that started answering 422 to it would break the one flow
         *     this route exists for, on the deployments least able to notice. Passing one
         *     without the other is refused, since it can only be a client bug.
         *
         *     ``setupToken`` is required only when the server says so — ``GET /api/status``
         *     publishes ``setupTokenRequired`` while the window is open precisely so the
         *     setup screen asks for it exactly when it is needed and never otherwise. It
         *     travels in the body rather than the query string on purpose: query strings
         *     land in access logs and browser history, and this one buys ownership of the
         *     library. camelCase to match the rest of this surface (see ``accounts/schemas.py``).
         *
         *     ``nestName`` names the server itself (``GET /api/status``'s ``name``) — the
         *     desktop sends «Nido de <computer name>». ⚠ Purely cosmetic and therefore
         *     **never a reason to refuse the claim**: a value that is not a usable name
         *     (wrong type, empty, too long, control characters) is dropped here and the
         *     server keeps its default name.
         */
        ClaimRequest: {
            /** Label */
            label: string;
            /** Setuptoken */
            setupToken?: string | null;
            /** Username */
            username?: string | null;
            /** Password */
            password?: string | null;
            /** Nestname */
            nestName?: string | null;
        };
        /** ClearLogRequest */
        ClearLogRequest: {
            /** File */
            file: string;
        };
        /** ClearLogResponse */
        ClearLogResponse: {
            /** File */
            file: string;
            /** Clearedbytes */
            clearedBytes: number;
        };
        /** ClearView */
        ClearView: {
            /** Cleared */
            cleared: number;
        };
        /** ComputeSummary */
        ComputeSummary: {
            /** Paused */
            paused: boolean;
            /** Waiting */
            waiting: number;
            /** Kinds */
            kinds: components["schemas"]["KindSummary"][];
            /** Computers */
            computers: components["schemas"]["Computer"][];
        };
        /** ComputedValues */
        ComputedValues: {
            /** Key */
            key: string | null;
            /** Bpm */
            bpm: number | null;
            /**
             * Keyestimated
             * @default false
             */
            keyEstimated: boolean;
            /**
             * Bpmestimated
             * @default false
             */
            bpmEstimated: boolean;
        };
        /** Computer */
        Computer: {
            /** Id */
            id: string;
            /**
             * Nest
             * @default false
             */
            nest: boolean;
            /** Name */
            name: string;
            /** Sessionid */
            sessionId?: string | null;
            /**
             * Os
             * @default macos
             * @enum {string}
             */
            os: "macos" | "windows" | "linux";
            /**
             * Accel
             * @default mlx
             * @enum {string}
             */
            accel: "mlx" | "cuda" | "cpu";
            /** Gpu */
            gpu?: string | null;
            /** Chip */
            chip?: string | null;
            /** Memorybytes */
            memoryBytes?: number | null;
            /** Jobs */
            jobs?: ("align" | "transcribe" | "stems" | "analysis")[];
            /** Utcoffsetminutes */
            utcOffsetMinutes?: number | null;
            /** Engines */
            engines?: {
                [key: string]: components["schemas"]["EngineInventory"];
            } | null;
            /** Onbattery */
            onBattery?: boolean | null;
            /** Powerreadable */
            powerReadable?: boolean | null;
            /** Speed */
            speed?: {
                [key: string]: {
                    [key: string]: number;
                };
            };
            /** Labels */
            labels?: string[];
            /**
             * Keepawake
             * @default none
             * @enum {string}
             */
            keepAwake: "held" | "failed" | "none";
            /** Goodbye */
            goodbye?: ("asleep" | "closed") | null;
            /** Macos */
            macos?: string | null;
            /** Version */
            version: string;
            /**
             * Minimumversion
             * @default 0.10.0
             */
            minimumVersion: string;
            /**
             * Versionstate
             * @default current
             * @enum {string}
             */
            versionState: "current" | "update" | "too-old";
            /**
             * State
             * @enum {string}
             */
            state: "working" | "idle" | "asleep" | "closed" | "offline" | "outdated" | "revoked";
            /** Lasterror */
            lastError?: ("network-denied" | "token-rejected" | "nest-unreachable") | null;
            /** Lastseenat */
            lastSeenAt: number;
            job?: components["schemas"]["WorkerJob"] | null;
            /** Disabledreason */
            disabledReason?: ("no-engine" | "no-cgroup" | "memory") | null;
            /** Disabledmessage */
            disabledMessage?: string | null;
            /** Blockedreasons */
            blockedReasons?: components["schemas"]["HelperBlockedReason"][];
            /** Pausedreason */
            pausedReason?: ("thermal" | "battery" | "hours" | "paused" | "off") | null;
            /** Temperaturec */
            temperatureC?: number | null;
            /** Cpulimitmode */
            cpuLimitMode?: ("cgroup" | "duty-cycle") | null;
            limits: components["schemas"]["WorkerLimits"];
        };
        /** ConfigChanges */
        ConfigChanges: {
            /** Changes */
            changes: {
                [key: string]: unknown;
            };
        };
        /**
         * CoverSize
         * @enum {integer}
         */
        CoverSize: 64 | 96 | 128 | 300;
        /**
         * CreateDeviceResponse
         * @description ``POST /api/me/devices`` **and** ``POST /api/login`` — 201.
         *
         *     ⚠ ``token`` is the plaintext secret and this is the **only** moment it
         *     exists anywhere, exactly as in :class:`CreateUserResponse`. It authenticates
         *     as the *same account* the caller is using — same library, same likes, same
         *     playlists — which is the entire point and also why it must be shown once and
         *     never logged.
         *
         *     ⚠ **Deliberately shared with the login route**, not copied. The two differ
         *     only in what they made the caller prove — a token it already held, or a
         *     username and password — and both end in "this client now has a device
         *     token". One model means one decoder, one place a field can be renamed, and
         *     no chance of the two drifting into subtly different shapes for the same
         *     event. It also means nothing password-specific may be added here: a field
         *     that only login fills would be a field ``POST /api/me/devices`` has to
         *     explain.
         */
        CreateDeviceResponse: {
            device: components["schemas"]["DevicePublic"];
            /** Token */
            token: string;
        };
        /**
         * CreatePlaylistResponse
         * @description ``POST /api/playlists``.
         */
        CreatePlaylistResponse: {
            /** Success */
            success: boolean;
            playlist: components["schemas"]["CreatedPlaylist"];
        };
        /**
         * CreateUserRequest
         * @description ``POST /api/users``. ``username`` and ``password`` are optional and must come together.
         *
         *     With them the person can sign in by name from the start (and add app passwords for
         *     Subsonic clients); without them the account has only the one-time token.
         */
        CreateUserRequest: {
            /** Label */
            label: string;
            /**
             * Role
             * @default member
             */
            role: string;
            /** Username */
            username?: string | null;
            /** Password */
            password?: string | null;
        };
        /**
         * CreateUserResponse
         * @description ``POST /api/users`` — 201.
         *
         *     ⚠ ``token`` is the plaintext secret and this is the **only** moment it
         *     exists anywhere: the store keeps a SHA-256 digest and cannot reproduce it.
         *     A client that does not show it here has lost it.
         */
        CreateUserResponse: {
            user: components["schemas"]["UserPublic"];
            /** Token */
            token: string;
        };
        /**
         * CreatedPlaylist
         * @description The playlist body nested in ``POST /api/playlists``.
         *
         *     ⚠ ISO-8601 strings here, floats in :class:`PlaylistSummary`. Creation is the
         *     only endpoint that formats the timestamps, and the renderer parses them as
         *     dates; changing either side breaks exactly one screen and not the other.
         *     ``tracks`` is always empty — a new playlist has none — but the key is
         *     present so a client can render the fresh playlist without a second GET.
         */
        CreatedPlaylist: {
            /** Name */
            name: string;
            /** Description */
            description?: string | null;
            /** Tracks */
            tracks?: components["schemas"]["PlaylistTrackResponse"][];
            /** Created At */
            created_at?: string | null;
            /** Modified At */
            modified_at?: string | null;
            /** Total Duration */
            total_duration?: number | null;
        };
        /** Decision */
        Decision: {
            /**
             * Duplicates
             * @default use-nest
             * @enum {string}
             */
            duplicates: "use-nest" | "keep-both";
        };
        /**
         * DeletePlaylistResponse
         * @description ``DELETE /api/playlists/{name}``. ``message`` is user-facing prose.
         */
        DeletePlaylistResponse: {
            /** Success */
            success: boolean;
            /** Message */
            message: string;
        };
        /** DeleteTrackRequest */
        DeleteTrackRequest: {
            /** Path */
            path: string;
        };
        /** DeleteTrackResponse */
        DeleteTrackResponse: {
            /** Success */
            success: boolean;
            /** Path */
            path: string;
            /**
             * Playlistsupdated
             * @default []
             */
            playlistsUpdated: components["schemas"]["PlaylistRemovalUpdate"][];
        };
        /** DeletionPreviewResponse */
        DeletionPreviewResponse: {
            /** Devices */
            devices: number;
            /** Songs */
            songs: number;
            /** Playlists */
            playlists: number;
            removable: components["schemas"]["RemovableSongs"];
            /** Kept */
            kept: number;
        };
        /**
         * DeviceListResponse
         * @description ``GET /api/me/devices`` — the caller's own devices, oldest first.
         */
        DeviceListResponse: {
            /** Devices */
            devices: components["schemas"]["DeviceListRow"][];
        };
        /**
         * DeviceListRow
         * @description A device as ``GET /api/me/devices`` lists it.
         *
         *     ``isCurrent`` marks the credential this very request arrived with, so the UI
         *     can say "this one" and warn before the user signs the machine in their hand
         *     out. Exactly one row carries it — or none, in the race where the calling
         *     device was revoked between the gate and the handler.
         */
        DeviceListRow: {
            /** Id */
            id: string;
            /** Label */
            label: string;
            /** Createdat */
            createdAt?: string | null;
            /** Lastseenat */
            lastSeenAt?: string | null;
            /** Credentialtype */
            credentialType?: ("app-password" | "api-key") | null;
            /** Firstsubsonicrequestat */
            firstSubsonicRequestAt?: string | null;
            /** Lastsubsonicrequestat */
            lastSubsonicRequestAt?: string | null;
            /** Subsonicclientname */
            subsonicClientName?: string | null;
            /** Lastsubsonicfailureat */
            lastSubsonicFailureAt?: string | null;
            /** Lastsubsonicfailure */
            lastSubsonicFailure?: "wrong-mechanism" | null;
            /**
             * Iscurrent
             * @default false
             */
            isCurrent: boolean;
            /**
             * Helper
             * @default false
             */
            helper: boolean;
        };
        /**
         * DevicePublic
         * @description One credential of the calling account. Mirrors ``DeviceRecord.public()``.
         *
         *     Shaped like :class:`UserPublic` minus ``role`` — a device does not have one,
         *     the account does — so a settings panel renders "people" and "my devices"
         *     with the same row component. Timestamps are ISO-8601 UTC strings for the
         *     same reason as above.
         *
         *     ⚠ ``id`` is the one id on this surface a client is expected to send back
         *     (``DELETE /api/me/devices/{id}``). It names a device of the **caller's own
         *     account** and nothing else: the store looks a device up scoped to the
         *     principal, so an id from somebody else's account reads as absent rather than
         *     as forbidden.
         */
        DevicePublic: {
            /** Id */
            id: string;
            /** Label */
            label: string;
            /** Createdat */
            createdAt?: string | null;
            /** Lastseenat */
            lastSeenAt?: string | null;
            /** Credentialtype */
            credentialType?: ("app-password" | "api-key") | null;
            /** Firstsubsonicrequestat */
            firstSubsonicRequestAt?: string | null;
            /** Lastsubsonicrequestat */
            lastSubsonicRequestAt?: string | null;
            /** Subsonicclientname */
            subsonicClientName?: string | null;
            /** Lastsubsonicfailureat */
            lastSubsonicFailureAt?: string | null;
            /** Lastsubsonicfailure */
            lastSubsonicFailure?: "wrong-mechanism" | null;
        };
        /** DiskModel */
        DiskModel: {
            /** Total */
            total: number;
            /** Free */
            free: number;
        };
        /** DownloadAlbumRequest */
        DownloadAlbumRequest: {
            /** Titulos */
            titulos: components["schemas"]["Cancion"][];
            /**
             * Genius Url
             * Format: uri
             */
            genius_url: string;
            /** Cover Url */
            cover_url?: string | null;
            /**
             * Normalize
             * @default false
             */
            normalize: boolean;
            /**
             * Effect Type
             * @default clean
             */
            effect_type: string;
            /**
             * Volume Boost
             * @default 4
             */
            volume_boost: number;
            /** Album */
            album?: string | null;
            /** Artista */
            artista?: string | null;
        };
        /** DownloadSongRequest */
        DownloadSongRequest: {
            /**
             * Genius Url
             * Format: uri
             */
            genius_url: string;
            /**
             * Normalize
             * @default false
             */
            normalize: boolean;
            /**
             * Effect Type
             * @default clean
             */
            effect_type: string;
            /**
             * Volume Boost
             * @default 4
             */
            volume_boost: number;
        };
        /** DuplicateDifference */
        DuplicateDifference: {
            /** Format */
            format: boolean;
            /** Bitrate */
            bitrate: number | null;
            /** Duration */
            duration: number | null;
            /** Plays */
            plays: number;
        };
        /** DuplicateFile */
        DuplicateFile: {
            /** Relpath */
            relPath: string;
            /** Title */
            title: string;
            /** Artist */
            artist: string;
            /** Album */
            album: string;
            /** Format */
            format: string;
            /** Bitrate */
            bitrate: number | null;
            /** Duration */
            duration: number | null;
            /** Plays */
            plays: number;
            /** Missing */
            missing: boolean;
            difference: components["schemas"]["DuplicateDifference"];
        };
        /** DuplicateGroup */
        DuplicateGroup: {
            /** Groupid */
            groupId: string;
            /**
             * Basis
             * @enum {string}
             */
            basis: "tags" | "audio";
            /** Keeper */
            keeper: string;
            /** Title */
            title: string;
            /** Artist */
            artist: string;
            /** Files */
            files: components["schemas"]["DuplicateFile"][];
        };
        /** DuplicateJob */
        DuplicateJob: {
            /** Jobid */
            jobId: string;
        };
        /** DuplicateKeep */
        DuplicateKeep: {
            /** Keep */
            keep: string;
        };
        /** DuplicateList */
        DuplicateList: {
            /** Jobid */
            jobId: string | null;
            /** State */
            state: string;
            /**
             * Audio
             * @enum {string}
             */
            audio: "not-scanned" | "unavailable" | "available";
            /** Audioskipped */
            audioSkipped: number;
            /** Groups */
            groups: components["schemas"]["DuplicateGroup"][];
        };
        /** EditResult */
        EditResult: {
            /** Editid */
            editId: string | null;
            /** Rev */
            rev: string;
            /** Changed */
            changed: boolean;
        };
        /** EffectiveValue */
        EffectiveValue: {
            /** Value */
            value: string | number | null;
            /** Source */
            source: ("fixed" | "tag" | "computed") | null;
            /** Estimated */
            estimated: boolean;
        };
        /** EngineInstallRequest */
        EngineInstallRequest: {
            /**
             * Target
             * @default engine
             * @enum {string}
             */
            target: "engine" | "lyrics" | "stems" | "analysis" | "gpu";
        };
        /** EngineInventory */
        EngineInventory: {
            /**
             * Installed
             * @default false
             */
            installed: boolean;
            /**
             * Ready
             * @default false
             */
            ready: boolean;
            /** Sizebytes */
            sizeBytes?: number | null;
            /** Sharedbytes */
            sharedBytes?: number | null;
        };
        /** EngineJobResponse */
        EngineJobResponse: {
            /** Progressid */
            progressId: string;
            /** Total */
            total: number;
            /** Jobid */
            jobId?: string | null;
            /**
             * Skipped
             * @default 0
             */
            skipped: number;
        };
        /** Entry */
        Entry: {
            /** Command */
            command?: string[] | null;
            /** Module */
            module?: string | null;
            /** Extra */
            extra?: string | null;
        };
        /** EstimateRow */
        EstimateRow: {
            /** Keyconfidence */
            keyConfidence?: number | null;
            /** Bpmconfidence */
            bpmConfidence?: number | null;
            /** Relpath */
            relPath: string;
            /** Title */
            title: string;
            /** Artist */
            artist: string;
            /** Album */
            album: string;
            /** Key */
            key: string | null;
            /** Keyestimated */
            keyEstimated: boolean;
            /** Keysource */
            keySource: ("fixed" | "tag" | "computed") | null;
            /** Bpm */
            bpm: number | null;
            /** Bpmestimated */
            bpmEstimated: boolean;
            /** Bpmsource */
            bpmSource: ("fixed" | "tag" | "computed") | null;
            /** Rev */
            rev: number;
        };
        /** EstimatedCounts */
        EstimatedCounts: {
            /** Songs */
            songs: number;
            /** Keys */
            keys: number;
            /** Bpms */
            bpms: number;
        };
        /** EstimatesPage */
        EstimatesPage: {
            /** Rows */
            rows: components["schemas"]["EstimateRow"][];
            /** After */
            after: string | null;
        };
        /**
         * ExportImportStartedResponse
         * @description ``POST .../import`` — the only step of the three that acquires anything.
         *
         *     ``destination`` is the directory the files will land in, echoed so a client
         *     can say where the music went without guessing the naming rules.
         */
        ExportImportStartedResponse: {
            /** Success */
            success: boolean;
            /** Status */
            status: string;
            /** Progress Id */
            progress_id: string;
            /** Playlistname */
            playlistName: string;
            /** Total */
            total: number;
            /** Destination */
            destination: string;
        };
        /**
         * ExportParseResponse
         * @description ``POST /api/playlists/spotify-export/parse`` — pure, no side effects.
         */
        ExportParseResponse: {
            /** Playlistcount */
            playlistCount: number;
            /** Trackcount */
            trackCount: number;
            /** Warnings */
            warnings: string[];
            /** Sourcefiles */
            sourceFiles: string[];
            /** Unreadmembers */
            unreadMembers: components["schemas"]["UnreadMemberResponse"][];
            /** Unrecognizedcount */
            unrecognizedCount: number;
            /** Playlists */
            playlists: components["schemas"]["ExportedPlaylistResponse"][];
        };
        /**
         * ExportResolutionResponse
         * @description ``GET .../resolve/{progress_id}`` — results grouped by confidence.
         *
         *     ``counts`` and ``results`` are keyed by confidence bucket (``strong`` /
         *     ``review`` / ``rejected``), and a bucket the matcher invents later must show
         *     up rather than be dropped — hence the mappings rather than three fields.
         *
         *     The match rows themselves stay free-form for the same reason
         *     ``AnalysisBlob`` does not exist next door: they are the matcher's own
         *     ``MatchResult`` dicts, they carry provider-specific keys, and a model that
         *     listed today's keys would quietly delete tomorrow's.
         *
         *     ``status`` is one of ``in_progress`` / ``done`` / ``cancelled`` / ``failed``;
         *     ``error`` carries how far it got before it broke, which is the field clients
         *     actually show.
         */
        ExportResolutionResponse: {
            /** Progressid */
            progressId: string;
            /** Playlistname */
            playlistName: string;
            /** Status */
            status: string;
            /** Total */
            total: number;
            /** Resolved */
            resolved: number;
            /** Counts */
            counts: {
                [key: string]: number;
            };
            /** Results */
            results: {
                [key: string]: {
                    [key: string]: unknown;
                }[];
            };
            /** Error */
            error?: string | null;
        };
        /**
         * ExportResolveCancelResponse
         * @description ``POST .../resolve/{progress_id}/cancel``.
         *
         *     ``status`` is read *before* the worker notices the flag, so it is usually
         *     still ``in_progress``. That is not a bug: cancellation is cooperative and
         *     whatever resolved so far is kept.
         */
        ExportResolveCancelResponse: {
            /** Success */
            success: boolean;
            /** Progressid */
            progressId: string;
            /** Status */
            status: string;
            /** Resolved */
            resolved: number;
        };
        /**
         * ExportResolveStartedResponse
         * @description ``POST .../resolve`` — the job id, returned before any work happens.
         *
         *     ⚠ ``progress_id`` is snake_case while ``playlistName`` beside it is camel.
         *     Both are read as-is by the renderer; the id also keys
         *     ``GET /api/download-progress-stream/{progress_id}``.
         */
        ExportResolveStartedResponse: {
            /** Success */
            success: boolean;
            /** Status */
            status: string;
            /** Progress Id */
            progress_id: string;
            /** Playlistname */
            playlistName: string;
            /** Total */
            total: number;
        };
        /**
         * ExportTrackListRequest
         * @description Body shared by /resolve and /import: a playlist name and its tracks.
         */
        ExportTrackListRequest: {
            /** Playlistname */
            playlistName: string;
            /** Tracks */
            tracks: components["schemas"]["ExportTrackRef"][];
        };
        /**
         * ExportTrackRef
         * @description A track the user picked out of a parsed export.
         *
         *     The identity fields are optional because /resolve is fed raw export rows
         *     that have none. /import is fed rows the user *approved* in the review step,
         *     and those do — carrying them through is what stops acquisition quietly
         *     fetching a different recording than the one that was approved.
         */
        ExportTrackRef: {
            /** Title */
            title: string;
            /** Artist */
            artist?: string | null;
            /** Album */
            album?: string | null;
            /** Durationseconds */
            durationSeconds?: number | null;
            /** Isrc */
            isrc?: string | null;
            /** Recordingmbid */
            recordingMbid?: string | null;
            /** Coverurl */
            coverUrl?: string | null;
            /** Provider */
            provider?: string | null;
            /** Providerid */
            providerId?: string | null;
            /** Mbid */
            mbid?: string | null;
        };
        /**
         * ExportedPlaylistResponse
         * @description A playlist named by an export, with everything it listed.
         */
        ExportedPlaylistResponse: {
            /** Name */
            name: string;
            /** Description */
            description?: string | null;
            /** Modifiedat */
            modifiedAt?: string | null;
            /** Trackcount */
            trackCount: number;
            /** Tracks */
            tracks: components["schemas"]["ExportedTrackResponse"][];
        };
        /**
         * ExportedTrackResponse
         * @description A song named by an export. Not resolved, not acquired, not on disk.
         */
        ExportedTrackResponse: {
            /** Title */
            title: string;
            /** Artist */
            artist?: string | null;
            /** Album */
            album?: string | null;
            /** Spotifyuri */
            spotifyUri?: string | null;
            /** Addedat */
            addedAt?: string | null;
        };
        /**
         * Extension
         * @description A host observation, including refused and legacy packages.
         */
        Extension: {
            /** Id */
            id: string;
            /** Kind */
            kind: ("engine" | "source" | "feature") | null;
            /** Name */
            name: string;
            /** Version */
            version?: string | null;
            /** Protocol */
            protocol?: {
                [key: string]: number[];
            };
            /** Runs */
            runs?: ("nest" | "helper" | "desktop")[];
            /** Adds */
            adds?: string[];
            /** Reaches */
            reaches?: string[];
            entry?: components["schemas"]["Entry"];
            /** License */
            license?: string | null;
            /** Homepage */
            homepage?: string | null;
            /**
             * State
             * @default on
             */
            state: string;
            /** Reason */
            reason?: string | null;
        };
        /** ExtensionsResponse */
        ExtensionsResponse: {
            /** Extensions */
            extensions: components["schemas"]["Extension"][];
            /** Accepted */
            accepted: {
                [key: string]: number[];
            };
        };
        /**
         * ExternalUrlRequest
         * @description ``PUT /api/server/external-url``. ``null`` or ``""`` clears it.
         */
        ExternalUrlRequest: {
            /** Url */
            url: string | null;
        };
        /** ExternalUrlResponse */
        ExternalUrlResponse: {
            /** Externalurl */
            externalUrl: string | null;
        };
        /** Fact */
        Fact: {
            /** Label */
            label: string;
            /** Value */
            value?: string | null;
            /** Tip */
            tip?: string | null;
        };
        /**
         * FailureKind
         * @enum {string}
         */
        FailureKind: "not-found" | "auth-required" | "rate-limited" | "blocked" | "network" | "broken" | "bug";
        /** FetchSpotifyPlaylistRequest */
        FetchSpotifyPlaylistRequest: {
            /** Playlist Url */
            playlist_url: string;
        };
        /** FixedRequest */
        FixedRequest: {
            /** Key */
            key?: string | null;
            /** Bpm */
            bpm?: number | null;
            /** Rev */
            rev: number;
        };
        /** GeniusCredentialsRequest */
        GeniusCredentialsRequest: {
            /**
             * Apikey
             * Format: password
             */
            apiKey: string;
        };
        /** GeniusCredentialsStatus */
        GeniusCredentialsStatus: {
            /** Configured */
            configured: boolean;
            /** Canmanage */
            canManage: boolean;
        };
        /** Group */
        Group: {
            /** Id */
            id: string;
            /** Settings */
            settings: components["schemas"]["Setting"][];
        };
        /** HTTPValidationError */
        HTTPValidationError: {
            /** Detail */
            detail?: components["schemas"]["ValidationError"][];
        };
        /** HealthCheck */
        HealthCheck: {
            /**
             * Id
             * @enum {string}
             */
            id: "missing" | "unreadable" | "estimates" | "duplicates" | "unmatched" | "remaster";
            /**
             * State
             * @default ready
             * @enum {string}
             */
            state: "ready" | "unavailable";
            /** Count */
            count?: number | null;
            /** Reason */
            reason?: string | null;
            source: components["schemas"]["HealthSource"];
            /** Folders */
            folders?: number | null;
            /** Topfolder */
            topFolder?: string | null;
            /** Keys */
            keys?: number | null;
            /** Bpms */
            bpms?: number | null;
            /** Songs */
            songs?: number | null;
            /** Sameaudio */
            sameAudio?: number | null;
            /** Sametags */
            sameTags?: number | null;
            /** Tracks */
            tracks?: components["schemas"]["HealthSong"][];
            /** Relpaths */
            relPaths?: string[];
            /** Albumkeys */
            albumKeys?: string[];
        };
        /** HealthSong */
        HealthSong: {
            /** Relpath */
            relPath: string;
            /** Title */
            title: string;
            /** Artist */
            artist: string;
        };
        /** HealthSource */
        HealthSource: {
            /** Store */
            store: string;
            /** Asof */
            asOf: string | null;
        };
        /** HealthStat */
        HealthStat: {
            /** Value */
            value: number | string | null;
            /**
             * State
             * @default ready
             * @enum {string}
             */
            state: "ready" | "unavailable";
            /** Reason */
            reason?: string | null;
            source: components["schemas"]["HealthSource"];
        };
        /** HealthStats */
        HealthStats: {
            songs: components["schemas"]["HealthStat"];
            albums: components["schemas"]["HealthStat"];
            addedThisWeek: components["schemas"]["HealthStat"];
            lastScanAt: components["schemas"]["HealthStat"];
            lastBackupAt: components["schemas"]["HealthStat"];
        };
        /** HelloEvent */
        HelloEvent: {
            /** Bootid */
            bootId: string;
            /** Revisions */
            revisions: {
                [key: string]: number | string;
            };
        };
        /** HelperBlockedReason */
        HelperBlockedReason: {
            /**
             * Code
             * @enum {string}
             */
            code: "no-engine" | "no-cgroup" | "memory" | "thermal";
            /** Kind */
            kind?: ("align" | "transcribe" | "stems" | "analysis") | null;
            /** Requiredbytes */
            requiredBytes?: number | null;
            /** Availablebytes */
            availableBytes?: number | null;
        };
        /** HelperCapabilities */
        HelperCapabilities: {
            /**
             * Os
             * @default macos
             * @enum {string}
             */
            os: "macos" | "windows" | "linux";
            /**
             * Accel
             * @default mlx
             * @enum {string}
             */
            accel: "mlx" | "cuda" | "cpu";
            /** Gpu */
            gpu?: string | null;
            /** Chip */
            chip?: string | null;
            /** Memorybytes */
            memoryBytes?: number | null;
            /**
             * Platform
             * @default
             */
            platform: string;
            /** Macos */
            macos?: string | null;
            /** Labels */
            labels?: string[];
            /** Utcoffsetminutes */
            utcOffsetMinutes?: number | null;
            /** Engines */
            engines?: {
                [key: string]: components["schemas"]["EngineInventory"];
            } | null;
            /** Onbattery */
            onBattery?: boolean | null;
            /**
             * Powerreadable
             * @default false
             */
            powerReadable: boolean;
            /** Pausedreason */
            pausedReason?: ("thermal" | "battery" | "hours" | "paused" | "off") | null;
            /**
             * Keepawake
             * @default none
             * @enum {string}
             */
            keepAwake: "held" | "failed" | "none";
        };
        /** HelperClaimRequest */
        HelperClaimRequest: {
            /** Kinds */
            kinds: ("align" | "transcribe" | "stems" | "analysis")[];
            capabilities?: components["schemas"]["HelperCapabilities"];
            /** Workerid */
            workerId?: string | null;
            /** Sessionid */
            sessionId?: string | null;
            /**
             * Name
             * @default Helper
             */
            name: string;
            /**
             * Version
             * @default
             */
            version: string;
        };
        /** HelperClaimResponse */
        HelperClaimResponse: {
            job: components["schemas"]["HelperJob"];
            /** Lease */
            lease: string;
        };
        /** HelperHeartbeatRequest */
        HelperHeartbeatRequest: {
            /** Lease */
            lease: string;
            /** Phase */
            phase?: string | null;
            /** Progress */
            progress?: number | null;
            agent?: components["schemas"]["AgentIdentity"] | null;
        };
        /** HelperJob */
        HelperJob: {
            /** Id */
            id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "align" | "transcribe" | "stems" | "analysis";
            /** Input */
            input: {
                [key: string]: unknown;
            };
        };
        /** HelperResultResponse */
        HelperResultResponse: {
            /** Accepted */
            accepted: boolean;
            /** Stop */
            stop?: boolean | null;
            /** Items */
            items?: {
                [key: string]: unknown;
            }[] | null;
            /** Reason */
            reason?: "lease-lost" | null;
            /** Status */
            status?: string | null;
            /** Requeued */
            requeued?: boolean | null;
        };
        /** HomeSnapshot */
        HomeSnapshot: {
            /** Albums */
            albums: components["schemas"]["AlbumWithMetadata"][];
            library: components["schemas"]["MyLibraryResponse"];
            /** Playlists */
            playlists: components["schemas"]["PlaylistSummary"][];
        };
        /** HostCPU */
        HostCPU: {
            /** Model */
            model: string | null;
            /** Cores */
            cores: number | null;
        };
        /** HostFacts */
        HostFacts: {
            /** Lastbackupat */
            lastBackupAt?: string | null;
            /** Lastbackupreason */
            lastBackupReason?: string | null;
            /** Hostname */
            hostname: string | null;
            os: components["schemas"]["HostOS"] | null;
            /** Kernel */
            kernel: string | null;
            /** Arch */
            arch: string | null;
            /** Isolation */
            isolation: ("lxc" | "docker" | "vm" | "none") | null;
            /** Hypervisor */
            hypervisor: "proxmox" | null;
            cpu: components["schemas"]["HostCPU"] | null;
            memory: components["schemas"]["HostMemory"] | null;
            /** Python */
            python: string | null;
            /** Bootedat */
            bootedAt: string | null;
            /** Startedat */
            startedAt: string | null;
            /** Engine */
            engine: ("local" | "agent") | null;
        };
        /** HostMemory */
        HostMemory: {
            /** Total */
            total: number | null;
            /** Used */
            used: number | null;
        };
        /** HostOS */
        HostOS: {
            /** Name */
            name: string | null;
            /** Version */
            version: string | null;
        };
        /** InstallRequest */
        InstallRequest: {
            /** Location */
            location?: string | null;
            /** Id */
            id?: string | null;
        };
        /** InstallResponse */
        InstallResponse: {
            /** Progress Id */
            progress_id: string;
        };
        /** ItemView */
        ItemView: {
            /** Idx */
            idx: number;
            /** Attempt */
            attempt: number;
            /** Item */
            item: string;
            /** Rel Path */
            rel_path: string | null;
            /** State */
            state: string;
            /** Reason */
            reason: string | null;
            /** Detail */
            detail: {
                [key: string]: unknown;
            };
        };
        /** ItemsView */
        ItemsView: {
            /** Items */
            items: components["schemas"]["ItemView"][];
        };
        /** JobView */
        JobView: {
            /** Id */
            id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "download" | "import" | "match" | "lyrics-search" | "lyrics-helper" | "stems" | "scan" | "upload" | "analysis" | "library-edit" | "source-install";
            /** Label */
            label: string;
            /**
             * State
             * @enum {string}
             */
            state: "queued" | "waiting" | "running" | "succeeded" | "partial" | "failed" | "cancelled" | "interrupted";
            /** Total */
            total: number;
            /** Succeeded */
            succeeded: number;
            /** Failed */
            failed: number;
            /** Skipped */
            skipped: number;
            /** Percent */
            percent: number;
            /** Phase */
            phase: string | null;
            /** Item */
            item: string | null;
            waitingOn: components["schemas"]["WaitingOn"] | null;
            /** Startedat */
            startedAt: number | null;
            /** Endedat */
            endedAt: number | null;
            /** Attempt */
            attempt: number;
            /** Failedcount */
            failedCount: number;
            /** Cancancel */
            canCancel: boolean;
            /** Canretry */
            canRetry: boolean;
        };
        /** JobsView */
        JobsView: {
            /** Jobs */
            jobs: components["schemas"]["JobView"][];
            /** Degraded */
            degraded: string[];
        };
        /** KeyExportRequest */
        KeyExportRequest: {
            /**
             * Password
             * Format: password
             */
            password: string;
        };
        /** KindPolicy */
        KindPolicy: {
            /** Kind */
            kind: string;
            /**
             * Placement
             * @enum {string}
             */
            placement: "helpers" | "helpers-then-nest" | "anywhere";
            /** Paused */
            paused: boolean;
            /** Nestafters */
            nestAfterS: number;
            /**
             * Librarypass
             * @enum {string}
             */
            libraryPass: "auto" | "ask" | "window";
            /** Requiredmemorybytes */
            requiredMemoryBytes: number;
        };
        /** KindSummary */
        KindSummary: {
            /**
             * Kind
             * @enum {string}
             */
            kind: "align" | "transcribe" | "stems" | "analysis";
            policy: components["schemas"]["KindPolicy"];
            /** Waiting */
            waiting: number;
            /** Oldestat */
            oldestAt: number | null;
            /** Failed */
            failed: number;
            /** Running */
            running: components["schemas"]["RunningWork"][];
            /** Reason */
            reason: ("paused" | "off" | "hours" | "battery" | "thermal" | "memory" | "no-engine" | "no-cgroup" | "no-helper" | "no-capable-helper" | "helpers-offline" | "helpers-busy" | "engine-disabled" | "helpers-only") | null;
            /** Waitingfor */
            waitingFor: string | null;
            /** Nestmemorybytes */
            nestMemoryBytes: number;
        };
        /** KindUpdate */
        KindUpdate: {
            /** Placement */
            placement?: ("helpers" | "helpers-then-nest" | "anywhere") | null;
            /** Paused */
            paused?: boolean | null;
            /** Librarypass */
            libraryPass?: ("auto" | "ask" | "window") | null;
        };
        /** KnownSource */
        KnownSource: {
            /** Id */
            id: string;
            /** Name */
            name: string;
            /** Facts */
            facts: string[];
            /** Location */
            location: string;
            /** Installed */
            installed: boolean;
        };
        /** KnownSourcesResponse */
        KnownSourcesResponse: {
            /** Sources */
            sources: components["schemas"]["KnownSource"][];
        };
        /**
         * LabelResponse
         * @description ``POST /api/me/label`` and ``POST /api/users/{id}/label`` — the row after.
         *
         *     The whole ``UserPublic`` rather than one key: a rename changes what every
         *     list on every client shows for this account, and the caller is about to
         *     redraw that row.
         */
        LabelResponse: {
            user: components["schemas"]["UserPublic"];
        };
        /** LegacySource */
        LegacySource: {
            /** Id */
            id: string;
            /** Name */
            name: string;
            /** Setting */
            setting: string;
            /** Location */
            location: string;
        };
        /** LegacySourcesResponse */
        LegacySourcesResponse: {
            /** Sources */
            sources: components["schemas"]["LegacySource"][];
        };
        /** LibraryHealthResponse */
        LibraryHealthResponse: {
            /** Checkedat */
            checkedAt: string | null;
            stats: components["schemas"]["HealthStats"];
            /** Checks */
            checks: components["schemas"]["HealthCheck"][];
        };
        /** LibraryScanRequest */
        LibraryScanRequest: {
            /**
             * Full
             * @default false
             */
            full: boolean;
        };
        /** LibraryScanStatus */
        LibraryScanStatus: {
            /** Scanning */
            scanning: boolean;
            /** Pending */
            pending: boolean;
            /** Watching */
            watching: boolean;
            /** Intervalseconds */
            intervalSeconds: number;
            /** Lastscanat */
            lastScanAt: string | null;
            /** Durationseconds */
            durationSeconds: number | null;
            /** Error */
            error: string | null;
        };
        /** LibrarySummaryResponse */
        LibrarySummaryResponse: {
            /** Folder */
            folder: string;
            /** Songs */
            songs: number;
            /** Albums */
            albums: number;
            /** Artists */
            artists: number;
        };
        /**
         * LoginRequest
         * @description ``POST /api/login``.
         *
         *     ⚠ **The validation here is length only, never shape.** A username that could
         *     not possibly exist — spaces, an ``@``, three hundred characters of nothing —
         *     must produce the same 401 as one that merely does not exist, and a pydantic
         *     ``422`` for "that is not a valid username" would tell an attacker which
         *     shapes are worth guessing before they spend a single attempt. So the field
         *     limits exist to bound the work (see ``passwords.MAX_PASSWORD_LENGTH``: the
         *     KDF runs on whatever arrives, on a public route) and nothing else; the store
         *     normalizes and looks up whatever it is handed.
         *
         *     ``deviceLabel`` is optional and names the machine in the household's device
         *     list. It is the only cosmetic field on this body and it must stay cosmetic:
         *     ⚠ there is no ``userId`` and there must never be one, exactly as in
         *     :class:`AddDeviceRequest` — the account comes from the password, so a body
         *     that could also name an account would be a body that mints a token for
         *     somebody else.
         */
        LoginRequest: {
            /** Username */
            username: string;
            /** Password */
            password: string;
            /** Devicelabel */
            deviceLabel?: string | null;
        };
        /** LyricsConfigRequest */
        LyricsConfigRequest: {
            /** Autofetch */
            autoFetch: boolean;
        };
        /** LyricsConfigResponse */
        LyricsConfigResponse: {
            /** Autofetch */
            autoFetch: boolean;
        };
        /** LyricsEngineResponse */
        LyricsEngineResponse: {
            worker?: components["schemas"]["MacWorker"] | null;
            /** Helpers */
            helpers?: components["schemas"]["MacWorker"][];
            /** Waitreason */
            waitReason?: ("no-helper" | "no-capable-helper" | "helpers-offline" | "helpers-busy") | null;
            /** Oldestat */
            oldestAt?: number | null;
            waiting?: components["schemas"]["MacWaitingResponse"] | null;
        } & {
            [key: string]: unknown;
        };
        /** LyricsJobsResponse */
        LyricsJobsResponse: {
            engine: components["schemas"]["LyricsEngineResponse"];
            /** Oldestpendingat */
            oldestPendingAt?: number | null;
        } & {
            [key: string]: unknown;
        };
        /** LyricsRecordResponse */
        LyricsRecordResponse: {
            /** Revision */
            revision?: string | null;
            /**
             * Offsetms
             * @default 0
             */
            offsetMs: number;
            /** Relpath */
            relPath: string;
            /** Kind */
            kind: string;
            /** Source */
            source: string;
            /** Providerref */
            providerRef?: string | null;
            /** Fetchedat */
            fetchedAt: number;
            /** Edited */
            edited: boolean;
            /** Sidecar */
            sidecar?: string | null;
            /** Title */
            title?: string | null;
            /** Artist */
            artist?: string | null;
            /** Lineconfidence */
            lineConfidence?: number[] | null;
            /** Lowlines */
            lowLines?: number[] | null;
            /** Result */
            result?: {
                [key: string]: unknown;
            } | null;
            /** Text */
            text: string;
        };
        /** LyricsStatesResponse */
        LyricsStatesResponse: {
            /** States */
            states: {
                [key: string]: "synced" | "plain" | "instrumental" | "pending" | "queued" | "none";
            };
            /** Counts */
            counts: {
                [key: string]: number;
            };
        };
        /** MacWaitingResponse */
        MacWaitingResponse: {
            /** Count */
            count: number;
            /** Oldestat */
            oldestAt?: number | null;
        };
        /** MacWorker */
        MacWorker: {
            /** Id */
            id: string;
            /**
             * Nest
             * @default false
             */
            nest: boolean;
            /** Name */
            name: string;
            /** Sessionid */
            sessionId?: string | null;
            /**
             * Os
             * @default macos
             * @enum {string}
             */
            os: "macos" | "windows" | "linux";
            /**
             * Accel
             * @default mlx
             * @enum {string}
             */
            accel: "mlx" | "cuda" | "cpu";
            /** Gpu */
            gpu?: string | null;
            /** Chip */
            chip?: string | null;
            /** Memorybytes */
            memoryBytes?: number | null;
            /** Jobs */
            jobs?: ("align" | "transcribe" | "stems" | "analysis")[];
            /** Utcoffsetminutes */
            utcOffsetMinutes?: number | null;
            /** Engines */
            engines?: {
                [key: string]: components["schemas"]["EngineInventory"];
            } | null;
            /** Onbattery */
            onBattery?: boolean | null;
            /** Powerreadable */
            powerReadable?: boolean | null;
            /** Speed */
            speed?: {
                [key: string]: {
                    [key: string]: number;
                };
            };
            /** Labels */
            labels?: string[];
            /**
             * Keepawake
             * @default none
             * @enum {string}
             */
            keepAwake: "held" | "failed" | "none";
            /** Goodbye */
            goodbye?: ("asleep" | "closed") | null;
            /** Macos */
            macos?: string | null;
            /** Version */
            version: string;
            /**
             * Minimumversion
             * @default 0.10.0
             */
            minimumVersion: string;
            /**
             * Versionstate
             * @default current
             * @enum {string}
             */
            versionState: "current" | "update" | "too-old";
            /**
             * State
             * @enum {string}
             */
            state: "working" | "idle" | "asleep" | "closed" | "offline" | "outdated" | "revoked";
            /** Lasterror */
            lastError?: ("network-denied" | "token-rejected" | "nest-unreachable") | null;
            /** Lastseenat */
            lastSeenAt: number;
            job?: components["schemas"]["WorkerJob"] | null;
            /** Disabledreason */
            disabledReason?: ("no-engine" | "no-cgroup" | "memory") | null;
            /** Disabledmessage */
            disabledMessage?: string | null;
            /** Blockedreasons */
            blockedReasons?: components["schemas"]["HelperBlockedReason"][];
            /** Pausedreason */
            pausedReason?: ("thermal" | "battery" | "hours" | "paused" | "off") | null;
            /** Temperaturec */
            temperatureC?: number | null;
            /** Cpulimitmode */
            cpuLimitMode?: ("cgroup" | "duty-cycle") | null;
        };
        /** Machine */
        Machine: {
            /** Cores */
            cores: number;
            /** Memorybytes */
            memoryBytes: number;
            /** Arch */
            arch: string;
            /** Container */
            container: string | null;
            /** Cpulimit */
            cpuLimit: number | null;
            /** Memorylimitbytes */
            memoryLimitBytes: number | null;
            /**
             * Suggestedpreset
             * @enum {string}
             */
            suggestedPreset: "light" | "normal" | "powerful";
            /** Presets */
            presets: {
                [key: string]: number[];
            };
            /** Capacitypresets */
            capacityPresets?: {
                [key: string]: {
                    [key: string]: number;
                };
            };
        };
        /** MatchApplyRequest */
        MatchApplyRequest: {
            /** Planhash */
            planHash: string;
        };
        /** MatchApplyResult */
        MatchApplyResult: {
            /** Editid */
            editId: string;
            /** Progressid */
            progressId: string;
            /** State */
            state: string;
            /** Applied */
            applied: number;
            /** Skipped */
            skipped: number;
            /** Failed */
            failed: number;
        };
        /** MatchCandidate */
        MatchCandidate: {
            /** Id */
            id: string;
            /** Title */
            title: string;
            /** Subtitle */
            subtitle: string;
            /**
             * Band
             * @enum {string}
             */
            band: "strong" | "review" | "weak";
            /** Reasons */
            reasons: string[];
            /** Files */
            files: components["schemas"]["MatchFile"][];
        };
        /** MatchDiff */
        MatchDiff: {
            /** Now */
            now: string | number | boolean | string[] | null;
            /** New */
            new: string | number | boolean | string[] | null;
        };
        /** MatchFailure */
        MatchFailure: {
            /** Relpath */
            relPath: string;
            /** Reason */
            reason: string;
        };
        /** MatchFile */
        MatchFile: {
            /** Relpath */
            relPath: string;
            /** Rev */
            rev: string;
            /** Fields */
            fields: {
                [key: string]: components["schemas"]["MatchDiff"];
            };
            /** Same */
            same: number;
        };
        /** MatchPlan */
        MatchPlan: {
            /** Planid */
            planId: string;
            /** Planhash */
            planHash: string;
            /** Rows */
            rows: components["schemas"]["MatchPlanRow"][];
        };
        /** MatchPlanRequest */
        MatchPlanRequest: {
            /** Rows */
            rows: components["schemas"]["MatchSelection"][];
        };
        /** MatchPlanRow */
        MatchPlanRow: {
            /** Relpath */
            relPath: string;
            /** Diff */
            diff: {
                [key: string]: (string | number | boolean | string[] | null)[];
            };
            /**
             * State
             * @enum {string}
             */
            state: "ok" | "no-change" | "changed-since";
        };
        /** MatchRequest */
        MatchRequest: {
            /** Relpaths */
            relPaths?: string[] | null;
            /** Albumkey */
            albumKey?: string | null;
            /** Query */
            query?: string | null;
            /** Link */
            link?: string | null;
        };
        /** MatchSelection */
        MatchSelection: {
            /** Relpath */
            relPath: string;
            /** Candidate */
            candidate: number;
            /** Fields */
            fields: string[];
        };
        /** MatchStarted */
        MatchStarted: {
            /** Jobid */
            jobId: string;
            /** Progressid */
            progressId: string;
        };
        /** MatchView */
        MatchView: {
            /** Jobid */
            jobId: string;
            /** State */
            state: string;
            /** Candidates */
            candidates: components["schemas"]["MatchCandidate"][];
            /** Groups */
            groups: {
                [key: string]: number[];
            };
            /** Errors */
            errors: components["schemas"]["MatchFailure"][];
        };
        /**
         * MeResponse
         * @description ``GET /api/me`` — who the auth gate decided the caller is.
         *
         *     The five identity keys mirror :class:`UserPublic` field for field so a
         *     client can compare this body against a row of ``GET /api/users`` and mark
         *     its own — and know, before it asks, whether a revoke would destroy the
         *     credential it is holding.
         *
         *     ``source`` says which *kind* of principal answered: ``token`` (a real row),
         *     ``shared-secret``, ``local``, ``anonymous`` or ``unknown``. The four
         *     sentinels have no row, so ``createdAt`` / ``lastSeenAt`` are ``null`` for
         *     them — inventing a ``createdAt`` would make a synthetic owner
         *     indistinguishable from a row that can actually be managed. They are also
         *     ``null`` in the one race where a real row was revoked between the gate and
         *     the handler.
         *
         *     ``isOwner`` is derived from ``role`` and duplicated on purpose: it saves
         *     every client re-deriving the one rule that matters.
         */
        MeResponse: {
            /** Id */
            id: string;
            /** Label */
            label: string;
            /** Role */
            role: string;
            /** Isowner */
            isOwner: boolean;
            /**
             * Onboarded
             * @default false
             */
            onboarded: boolean;
            /** Source */
            source: string;
            /** Username */
            username?: string | null;
            /** Createdat */
            createdAt?: string | null;
            /** Lastseenat */
            lastSeenAt?: string | null;
        };
        /** MissingAccount */
        MissingAccount: {
            /** Id */
            id: string;
            /** Name */
            name: string;
        };
        /** MissingApply */
        MissingApply: {
            /** Rows */
            rows: components["schemas"]["MissingApplyRow"][];
        };
        /** MissingApplyRow */
        MissingApplyRow: {
            /** Relpath */
            relPath: string;
            /** Target */
            target: string;
            /** Rev */
            rev: string;
        };
        /**
         * MissingLibraryResponse
         * @description ``GET /api/me/library/missing`` — owned paths whose files are gone.
         */
        MissingLibraryResponse: {
            /** Relpaths */
            relPaths: string[];
        };
        /** MissingListing */
        MissingListing: {
            /** Rows */
            rows: components["schemas"]["MissingRow"][];
            /** Libraryavailable */
            libraryAvailable: boolean;
            /** Librarycount */
            libraryCount: number;
        };
        /** MissingMatch */
        MissingMatch: {
            /** Relpath */
            relPath: string;
            /** Target */
            target: string | null;
            /** Rev */
            rev: string | null;
            /** Reason */
            reason: string | null;
        };
        /** MissingOutcome */
        MissingOutcome: {
            /** Editid */
            editId: string;
            /** Rows */
            rows: components["schemas"]["MissingOutcomeRow"][];
        };
        /** MissingOutcomeRow */
        MissingOutcomeRow: {
            /** Relpath */
            relPath: string;
            /** State */
            state: string;
            /** Reason */
            reason: string | null;
        };
        /** MissingPreview */
        MissingPreview: {
            /** Rows */
            rows: components["schemas"]["MissingMatch"][];
        };
        /** MissingReferences */
        MissingReferences: {
            /** Accounts */
            accounts: components["schemas"]["MissingAccount"][];
            /** Playlists */
            playlists: string[];
            /** Playlistentries */
            playlistEntries: number;
            /** Corrections */
            corrections: string[];
            /** Plays */
            plays: number;
            /** Likes */
            likes: number;
            /** Lyric */
            lyric: boolean;
            /** Analysis */
            analysis: boolean;
            /** Stems */
            stems: boolean;
        };
        /** MissingRemoval */
        MissingRemoval: {
            /** Relpaths */
            relPaths: string[];
            /**
             * Confirmlarge
             * @default false
             */
            confirmLarge: boolean;
        };
        /** MissingRow */
        MissingRow: {
            /** Relpath */
            relPath: string;
            /** Path */
            path: string;
            /** Title */
            title: string;
            /** Size */
            size: number | null;
            /** Missingsince */
            missingSince: string | null;
            /** Cause */
            cause: string;
            /** Folder */
            folder: string;
            references: components["schemas"]["MissingReferences"];
            /** Movedto */
            movedTo: string | null;
        };
        /** MissingSearch */
        MissingSearch: {
            /** Relpaths */
            relPaths: string[];
            /** Folder */
            folder?: string | null;
            /** Target */
            target?: string | null;
        };
        /**
         * MoveTrackRequest
         * @description Move a song into an album's folder (``domains/music/relocation.py``).
         *
         *     ``path`` is the server's absolute path, as an ownership verdict's ``match``
         *     carries it. The target is ``albumDir`` (an existing library album's key)
         *     or, without it, the folder a download of ``albumTitle`` would land in.
         *     ``albumTitle``/``trackNumber`` are also written to the tags (MP3 only).
         */
        MoveTrackRequest: {
            /** Path */
            path: string;
            /** Albumdir */
            albumDir?: string | null;
            /** Albumtitle */
            albumTitle?: string | null;
            /** Tracknumber */
            trackNumber?: number | null;
        };
        /**
         * MyLibraryResponse
         * @description ``GET /api/me/library`` — oldest first.
         *
         *     Absent files keep their rows. File presence lives at ``/library/missing``.
         */
        MyLibraryResponse: {
            /** Tracks */
            tracks: components["schemas"]["UserTrackRow"][];
            /** Count */
            count: number;
        };
        /**
         * MyOwnershipResponse
         * @description ``POST /api/me/library/ownership`` — **positional**, never filtered.
         *
         *     ``results[i]`` answers ``relPaths[i]``, always. Repeats are answered in place
         *     rather than de-duplicated, because positional means positional, and a client
         *     drawing ownership markers by index would otherwise draw them on wrong rows.
         *
         *     Distinct from ``POST /api/library/ownership`` in the music domain and both
         *     are needed: that one asks, fuzzily by title and artist, whether the *shared
         *     library* has a catalog track; this one asks, exactly by ``relPath``, whether
         *     *you* have a known file.
         */
        MyOwnershipResponse: {
            /** Results */
            results: components["schemas"]["MyOwnershipVerdict"][];
        };
        /**
         * MyOwnershipVerdict
         * @description Whether the caller holds one specific ``relPath``.
         *
         *     ``relPath`` is echoed so a positional misalignment is detectable rather than
         *     silent — see :class:`MyOwnershipResponse`.
         */
        MyOwnershipVerdict: {
            /** Relpath */
            relPath: string;
            /** Owned */
            owned: boolean;
        };
        /** OnboardedResponse */
        OnboardedResponse: {
            /** Onboarded */
            onboarded: boolean;
        };
        /** OutsideVisitModel */
        OutsideVisitModel: {
            /** At */
            at: string;
            /**
             * Via
             * @enum {string}
             */
            via: "vpn" | "tailscale" | "proxy";
        };
        /**
         * OwnedTrackRef
         * @description A library file that answers an ownership query.
         */
        OwnedTrackRef: {
            /** Title */
            title: string;
            /** Artist */
            artist: string;
            /** Album */
            album: string;
            /** Path */
            path: string;
            /** Durationseconds */
            durationSeconds?: number | null;
            /** Tracknumber */
            trackNumber?: number | null;
        };
        /** OwnershipQuery */
        OwnershipQuery: {
            /** Title */
            title: string;
            /** Artist */
            artist?: string | null;
            /** Durationseconds */
            durationSeconds?: number | null;
        };
        /** OwnershipRequest */
        OwnershipRequest: {
            /** Tracks */
            tracks: components["schemas"]["OwnershipQuery"][];
        };
        /**
         * OwnershipResponse
         * @description ``POST /api/library/ownership`` — **positional**, never filtered.
         *
         *     ⚠ ``degraded`` is absent on the happy path and ``true`` when the library
         *     could not be read; the route is declared with
         *     ``response_model_exclude_unset=True`` precisely so a default of ``None``
         *     here does not start emitting ``"degraded": null`` on every successful call.
         *     A client that sees ``degraded`` draws no ownership markers at all, so the
         *     key appearing where it never used to would blank every marker in the app.
         */
        OwnershipResponse: {
            /** Results */
            results?: components["schemas"]["OwnershipVerdictResponse"][];
            /** Degraded */
            degraded?: boolean | null;
        };
        /**
         * OwnershipVerdictResponse
         * @description One verdict. ``nearMatch`` is a same-key file that was *rejected*.
         */
        OwnershipVerdictResponse: {
            /** Owned */
            owned: boolean;
            match?: components["schemas"]["OwnedTrackRef"] | null;
            nearMatch?: components["schemas"]["OwnedTrackRef"] | null;
            /** Reason */
            reason?: string | null;
        };
        /**
         * PasswordChangeResponse
         * @description ``POST /api/me/password`` — it worked, and what it did *not* do.
         *
         *     ⚠ ``otherDevicesSignedOut`` is always ``false`` and exists to say so out
         *     loud. Changing a password here does not revoke anything — the reasoning is
         *     on the route — and the one thing a user is entitled to assume after changing
         *     a password is that they have just evicted whoever they were worried about.
         *     They have not. A client that shows this field, and ``deviceCount`` beside it,
         *     can send them to the device list, which is where evicting somebody actually
         *     happens.
         *
         *     ``deviceCount`` is every device on the account, including the one making the
         *     request, so "3 devices are still signed in" is literally true.
         */
        PasswordChangeResponse: {
            /** Success */
            success: boolean;
            /** Otherdevicessignedout */
            otherDevicesSignedOut: boolean;
            /** Devicecount */
            deviceCount: number;
        };
        /** PatchRequest */
        PatchRequest: {
            /** Relpath */
            relPath: string;
            /** Liked */
            liked?: boolean | null;
            /** Offline */
            offline?: boolean | null;
        };
        /** PauseRequest */
        PauseRequest: {
            /** Paused */
            paused: boolean;
        };
        /** PendingListResponse */
        PendingListResponse: {
            /** Pendingcount */
            pendingCount: number;
            /** Pending */
            pending: components["schemas"]["PendingTrackResponse"][];
        };
        /** PendingTrackResponse */
        PendingTrackResponse: {
            /** Relpath */
            relPath: string;
            /** Title */
            title: string;
            /** Artist */
            artist: string;
            /** Album */
            album: string;
            /** Triedat */
            triedAt: number;
            /** Reason */
            reason: string;
        };
        /** PlayEventRow */
        PlayEventRow: {
            /** Id */
            id: string;
            /** Relpath */
            relPath: string;
            /** Startedat */
            startedAt: string;
            /** Playedseconds */
            playedSeconds: number | null;
            /** Completed */
            completed: boolean;
            /**
             * Source
             * @enum {string}
             */
            source: "desktop" | "phone" | "subsonic";
            /** Deviceid */
            deviceId: string | null;
        };
        /** PlayHistoryResponse */
        PlayHistoryResponse: {
            /** Events */
            events: components["schemas"]["PlayEventRow"][];
            /** Nextcursor */
            nextCursor: string | null;
        };
        /** PlayRequest */
        PlayRequest: {
            /** Startedat */
            startedAt?: string | null;
            /** Playedseconds */
            playedSeconds?: number | null;
            /**
             * Completed
             * @default true
             */
            completed: boolean;
            /** Source */
            source?: ("desktop" | "phone") | null;
            /** Relpath */
            relPath: string;
        };
        /** PlaylistCreateRequest */
        PlaylistCreateRequest: {
            /** Name */
            name: string;
            /** Description */
            description?: string | null;
        };
        /**
         * PlaylistDetail
         * @description ``GET /api/playlists/{name}`` — the flat, un-enveloped playlist.
         */
        PlaylistDetail: {
            /** Name */
            name: string;
            /** Description */
            description?: string | null;
            /** Tracks */
            tracks: components["schemas"]["PlaylistTrackResponse"][];
            /** Created */
            created?: number | null;
            /** Modified */
            modified?: number | null;
            /** Source Url */
            source_url?: string | null;
            /** Cover */
            cover?: string | null;
            /** Owner */
            owner?: string | null;
        };
        /** PlaylistItem */
        PlaylistItem: {
            /** Path */
            path: string;
            /** Title */
            title: string;
            /** Artist */
            artist?: string | null;
            /** Album */
            album?: string | null;
            /** Track Number */
            track_number?: number | null;
            /** Duration */
            duration?: number | null;
            /** Dateadded */
            dateAdded?: number | null;
        };
        /**
         * PlaylistRemovalUpdate
         * @description A playlist changed automatically by a committed track removal.
         */
        PlaylistRemovalUpdate: {
            /** Name */
            name: string;
            /** Removed */
            removed: number;
        };
        /** PlaylistRenameRequest */
        PlaylistRenameRequest: {
            /** New Name */
            new_name: string;
        };
        /**
         * PlaylistSummary
         * @description One row of ``GET /api/playlists``.
         *
         *     ``owner`` is additive — it was introduced with per-user tokens and both
         *     shipped clients ignore it — and it is ``null`` for a playlist written before
         *     ownership existed or dropped into the directory by hand.
         */
        PlaylistSummary: {
            /** Name */
            name: string;
            /** Description */
            description?: string | null;
            /** Trackcount */
            trackCount: number;
            /** Created */
            created?: number | null;
            /** Modified */
            modified?: number | null;
            /** Owner */
            owner?: string | null;
            /** Cover */
            cover?: string | null;
            /**
             * Coveralbums
             * @default []
             */
            coverAlbums: string[];
            /**
             * Coverversions
             * @default []
             */
            coverVersions: (string | null)[];
            /** Totalduration */
            totalDuration?: number | null;
        };
        /**
         * PlaylistTrackResponse
         * @description A track as ``GET /api/playlists/{name}`` renders it.
         *
         *     ``track_number`` is the **position in the playlist** (1-based), not the
         *     track's number on its album — the handler overwrites it on purpose so a
         *     reordered playlist numbers correctly.
         *
         *     ``artist`` and ``title`` are empty strings rather than ``null`` when unknown:
         *     the handler coerces them, and a client that renders ``track.artist`` would
         *     print "None" if that ever changed.
         */
        PlaylistTrackResponse: {
            /** Path */
            path: string;
            /** Title */
            title: string;
            /** Artist */
            artist: string;
            /** Album */
            album?: string | null;
            /** Genre */
            genre?: string | null;
            /** Track Number */
            track_number?: number | null;
            /** Duration */
            duration?: number | null;
            /** Dateadded */
            dateAdded?: number | null;
        };
        /**
         * PlaylistUrlImportRequest
         * @description Body for import-playlist-url (legacy: playlist_url).
         */
        PlaylistUrlImportRequest: {
            /** Playlist Url */
            playlist_url: string;
            /**
             * Normalize
             * @default false
             */
            normalize: boolean;
            /**
             * Effect Type
             * @default clean
             */
            effect_type: string;
            /**
             * Volume Boost
             * @default 4
             */
            volume_boost: number;
            /** Selected Indices */
            selected_indices?: number[] | null;
        };
        /** PlaysAccepted */
        PlaysAccepted: {
            /** Accepted */
            accepted: number;
        };
        /** PlaysBatch */
        PlaysBatch: {
            /** Plays */
            plays: components["schemas"]["BatchPlay"][];
        };
        /** PollSignInCodeRequest */
        PollSignInCodeRequest: {
            /** Secret */
            secret: string;
        };
        /** ProviderFormatResponse */
        ProviderFormatResponse: {
            /** Codec */
            codec: string;
            /** Bitratekbps */
            bitrateKbps: number | null;
            /** Container */
            container: string;
            /** Transcoded */
            transcoded: boolean | null;
        };
        /** ProviderHealthResponse */
        ProviderHealthResponse: {
            /**
             * State
             * @enum {string}
             */
            state: "ok" | "busy" | "broken";
            kind?: components["schemas"]["FailureKind"] | null;
            /** Level */
            level?: number | null;
            /** Until */
            until?: number | null;
            /** Since */
            since?: number | null;
            /** Firstfailureat */
            firstFailureAt?: number | null;
            /** Lastfailureat */
            lastFailureAt?: number | null;
        };
        /**
         * ProviderKind
         * @description The question a provider can answer.
         *
         *     Only kinds that have a consumer: a kind for a surface Flipspin does not have
         *     (discovery, say) would be invented before its consumer exists, which is how
         *     enums rot. Adding one later is a single member.
         * @enum {string}
         */
        ProviderKind: "metadata" | "lyrics" | "streaming" | "dashboard";
        /** ProviderOrderRequest */
        ProviderOrderRequest: {
            /** Order */
            order?: string[];
        };
        /** ProviderResponse */
        ProviderResponse: {
            /** Id */
            id: string;
            kind: components["schemas"]["ProviderKind"];
            /** Name */
            name: string;
            /** Description */
            description: string;
            /** Enabled */
            enabled: boolean;
            /** Position */
            position: number;
            /** Available */
            available: boolean;
            /** Requirescredentials */
            requiresCredentials: boolean;
            /** Capabilities */
            capabilities: string[];
            /** Unavailablereason */
            unavailableReason: string | null;
            health: components["schemas"]["ProviderHealthResponse"];
            format?: components["schemas"]["ProviderFormatResponse"] | null;
            ytdlp?: components["schemas"]["YtdlpResponse"] | null;
            status?: components["schemas"]["SourceStatus"] | null;
        };
        /** ProviderToggleRequest */
        ProviderToggleRequest: {
            /** Enabled */
            enabled: boolean;
        };
        /** ProvidersResponse */
        ProvidersResponse: {
            /** Providers */
            providers: components["schemas"]["ProviderResponse"][];
        };
        /**
         * RefreshFromSourceResponse
         * @description ``POST /api/refresh-playlist/{name}`` — re-fetches the source URL.
         *
         *     ⚠ ``status`` is the string ``"success"`` even when nothing was added, and
         *     ``message`` is Spanish prose meant for display. Branch on ``added``, never
         *     on either of the other two.
         */
        RefreshFromSourceResponse: {
            /** Status */
            status: string;
            /** Message */
            message: string;
            /** Added */
            added: number;
        };
        /**
         * RefreshPlaylistResponse
         * @description ``POST /api/playlists/{name}/refresh`` — tags re-read, nothing fetched.
         */
        RefreshPlaylistResponse: {
            /** Success */
            success: boolean;
            playlist: components["schemas"]["RefreshedPlaylistCounts"];
        };
        /**
         * RefreshedPlaylistCounts
         * @description ``POST /api/playlists/{name}/refresh``'s nested body.
         *
         *     Adds an ISO-8601 ``modified_at`` to the counts above. It is the *third*
         *     spelling of "when this changed" across this router; see the module docstring.
         */
        RefreshedPlaylistCounts: {
            /** Name */
            name: string;
            /** Track Count */
            track_count: number;
            /** Total Duration */
            total_duration?: number | null;
            /** Modified At */
            modified_at?: string | null;
        };
        /** RelPathsRequest */
        RelPathsRequest: {
            /** Relpaths */
            relPaths?: string[];
        };
        /** RemoteRouteRequest */
        RemoteRouteRequest: {
            /** Route */
            route?: unknown;
        };
        /** RemoteRouteResponse */
        RemoteRouteResponse: {
            /**
             * Route
             * @enum {string}
             */
            route: "tailscale" | "wireguard" | "domain" | "local";
        };
        /** RemovableSongs */
        RemovableSongs: {
            /** Count */
            count: number;
            /** Bytes */
            bytes: number;
        };
        /**
         * RemoveFromLibraryResponse
         * @description ``DELETE /api/me/library`` — **rows only. The files stay on disk.**
         *
         *     ⚠ Not ``POST /api/delete-track``. That one unlinks the audio and every
         *     member loses it forever; this one forgets a reference that one POST brings
         *     straight back. ``removed`` lists only what the caller actually held, so a
         *     retried DELETE is harmless and answers a short list.
         */
        RemoveFromLibraryResponse: {
            /** Removed */
            removed: string[];
            /** Playlistsupdated */
            playlistsUpdated?: components["schemas"]["PlaylistRemovalUpdate"][];
        };
        /**
         * RenameDeviceRequest
         * @description A display name, scoped to the caller's device by the route.
         */
        RenameDeviceRequest: {
            /** Label */
            label: string;
        };
        /**
         * RenamePlaylistResponse
         * @description ``PATCH /api/playlists/{name}``.
         */
        RenamePlaylistResponse: {
            /** Success */
            success: boolean;
            playlist: components["schemas"]["RenamedPlaylist"];
        };
        /**
         * RenamedPlaylist
         * @description The body nested in ``PATCH /api/playlists/{name}``. camelCase + floats.
         */
        RenamedPlaylist: {
            /** Name */
            name: string;
            /** Description */
            description?: string | null;
            /** Trackcount */
            trackCount: number;
            /** Created */
            created?: number | null;
            /** Modified */
            modified?: number | null;
        };
        /** ReplayGain */
        ReplayGain: {
            /** Trackgain */
            trackGain?: number | null;
            /** Albumgain */
            albumGain?: number | null;
            /** Trackpeak */
            trackPeak?: number | null;
            /** Albumpeak */
            albumPeak?: number | null;
            /**
             * Basegain
             * @default 0
             */
            baseGain: number;
        };
        /** Request */
        Request: {
            /**
             * Kind
             * @default song
             * @enum {string}
             */
            kind: "song" | "album" | "playlist";
            /** Provider */
            provider: string;
            /** Provider Id */
            provider_id: string;
            /** Title */
            title: string;
            /** Tracks */
            tracks: components["schemas"]["Track"][];
            /** Folder */
            folder?: string | null;
        };
        /**
         * ResetPasswordRequest
         * @description ``POST /api/users/{id}/password``. ``username`` gives a token-only account the name it
         *     signs in with, in the same call; it is used only when the account has none yet.
         */
        ResetPasswordRequest: {
            /** Newpassword */
            newPassword: string;
            /** Username */
            username?: string | null;
        };
        /** RestartRequest */
        RestartRequest: {
            /**
             * When
             * @default idle
             * @enum {string}
             */
            when: "idle" | "now";
        };
        /** RestartResponse */
        RestartResponse: {
            /** Restarting */
            restarting: boolean;
            /**
             * When
             * @enum {string}
             */
            when: "idle" | "now";
            /** Command */
            command?: string | null;
        };
        /** RestartState */
        RestartState: {
            /** Pending */
            pending: string[];
            /** Supported */
            supported: boolean;
            /**
             * How
             * @enum {string}
             */
            how: "systemd" | "docker" | "desktop" | "none";
            /** Command */
            command?: string | null;
        };
        /**
         * RestoreLyricsMetadata
         * @description Renderer-held metadata for undo; no history is retained on the server.
         */
        RestoreLyricsMetadata: {
            /** Fetchedat */
            fetchedAt: number;
            /** Title */
            title?: string | null;
            /** Artist */
            artist?: string | null;
            /** Lineconfidence */
            lineConfidence?: number[] | null;
            /** Lowlines */
            lowLines?: number[] | null;
            /** Result */
            result?: {
                [key: string]: unknown;
            } | null;
        };
        /** RetryDownloadRequest */
        RetryDownloadRequest: {
            /** Progress Id */
            progress_id: string;
            /** Index */
            index: number;
            /** Youtube Url */
            youtube_url: string;
        };
        /** RetryDownloadResponse */
        RetryDownloadResponse: {
            /** Success */
            success: boolean;
            /** Status */
            status: string;
            /** Progress Id */
            progress_id: string;
            /** Total */
            total: number;
            /** Label */
            label: string;
        };
        /** RetryRequest */
        RetryRequest: {
            /** Attempt */
            attempt?: number | null;
        };
        /** RetrySelection */
        RetrySelection: {
            /** Index */
            index: number;
            /** Youtube Url */
            youtube_url?: string | null;
        };
        /**
         * RevokeDeviceResponse
         * @description ``DELETE /api/me/devices/{id}`` — the device as it was when revoked.
         *
         *     ⚠ ``signedOutThisDevice`` is ``true`` when the caller revoked the credential
         *     it is holding. That is a supported thing to do — it is how "sign this phone
         *     out" works — but every subsequent request from this client will be a 401,
         *     and a client that rendered that as a server fault would be showing a bug
         *     where it should be showing a login screen.
         */
        RevokeDeviceResponse: {
            /** Success */
            success: boolean;
            device: components["schemas"]["DevicePublic"];
            /** Signedoutthisdevice */
            signedOutThisDevice: boolean;
        };
        /**
         * RevokeUserResponse
         * @description ``DELETE /api/users/{user_id}`` — the row as it was when revoked.
         */
        RevokeUserResponse: {
            /** Success */
            success: boolean;
            user: components["schemas"]["UserPublic"];
            /** Removedsongs */
            removedSongs: number;
            /** Freedbytes */
            freedBytes: number;
            /**
             * Playlists
             * @enum {string}
             */
            playlists: "transferred" | "deleted";
        };
        /** RunConflictDetail */
        RunConflictDetail: {
            /**
             * Code
             * @enum {string}
             */
            code: "run-in-progress" | "no-helper" | "library-unavailable" | "migrating" | "scan-busy";
            /** Runid */
            runId?: string | null;
            /** Waiting */
            waiting?: ("no-helper" | "no-capable-helper" | "helpers-offline" | "helpers-busy") | null;
        };
        /** RunConflictResponse */
        RunConflictResponse: {
            detail: components["schemas"]["RunConflictDetail"];
        };
        /** RunCounts */
        RunCounts: {
            /** Queued */
            queued: number;
            /** Joined */
            joined: number;
            /** Skipped */
            skipped: {
                [key: string]: number;
            };
            /** Same */
            same: number;
            /** Changed */
            changed: number;
            /** Toestimated */
            toEstimated: number;
            /** Toconfident */
            toConfident: number;
            /** Failed */
            failed: number;
        };
        /** RunPreview */
        RunPreview: {
            /** Waiting */
            waiting: number;
            /** Outdated */
            outdated: number;
            /** Failed */
            failed: number;
            /** Correctionskept */
            correctionsKept: number;
            /** Confirmationskept */
            confirmationsKept: number;
            /** Size */
            size: number;
            /** Skipped */
            skipped: components["schemas"]["SkippedTrack"][];
            /** Estimateseconds */
            estimateSeconds: number | null;
        };
        /** RunProgress */
        RunProgress: {
            /** Id */
            id: string;
            /** Jobid */
            jobId: string;
            /**
             * Mode
             * @enum {string}
             */
            mode: "new" | "outdated" | "all";
            /**
             * Scope
             * @enum {string}
             */
            scope: "library" | "selection" | "song";
            /** Size */
            size: number;
            /** Done */
            done: number;
            /** Failed */
            failed: number;
            /** Waiting */
            waiting: ("no-helper" | "no-capable-helper" | "helpers-offline" | "helpers-busy") | null;
            /** Etaseconds */
            etaSeconds: number | null;
            counts: components["schemas"]["RunCounts"];
        };
        /** RunRequest */
        RunRequest: {
            /** Requestid */
            requestId: string;
            /**
             * Mode
             * @default new
             * @enum {string}
             */
            mode: "new" | "outdated" | "all";
            /**
             * Scope
             * @default library
             * @enum {string}
             */
            scope: "library" | "selection" | "song";
            /** Relpaths */
            relPaths?: string[];
        };
        /** RunResponse */
        RunResponse: {
            run: components["schemas"]["RunView"] | null;
            /** Queued */
            queued: number;
            /** Joined */
            joined: boolean;
            /** Skipped */
            skipped: components["schemas"]["SkippedTrack"][];
        };
        /** RunView */
        RunView: {
            /** Id */
            id: string;
            /** Jobid */
            jobId: string;
            /**
             * Mode
             * @enum {string}
             */
            mode: "new" | "outdated" | "all";
            /**
             * Scope
             * @enum {string}
             */
            scope: "library" | "selection" | "song";
            /** Size */
            size: number;
        };
        /** RunningWork */
        RunningWork: {
            /** Workerid */
            workerId: string;
            /** Title */
            title: string;
            /** Progress */
            progress: number | null;
        };
        /** SaveLyricsRequest */
        SaveLyricsRequest: {
            restore?: components["schemas"]["RestoreLyricsMetadata"] | null;
            /**
             * Kind
             * @description synced | plain | instrumental
             */
            kind: string;
            /**
             * Text
             * @default
             */
            text: string;
            /**
             * Source
             * @description lrclib | genius | manual | file | stt:…
             * @default manual
             */
            source: string;
            /** Providerref */
            providerRef?: string | null;
            /**
             * Edited
             * @default false
             */
            edited: boolean;
            /**
             * Force
             * @default false
             */
            force: boolean;
            /**
             * Expectedrevision
             * @description Conditional save: last read revision; empty string means no lyric
             */
            expectedRevision?: string | null;
        };
        /** ScanRequest */
        ScanRequest: {
            /** Tracks */
            tracks?: components["schemas"]["TrackRef"][];
        };
        /** ScanResponse */
        ScanResponse: {
            /** Started */
            started: boolean;
            /** Jobid */
            jobId?: string | null;
            /** Progressid */
            progressId?: string | null;
            /**
             * Total
             * @default 0
             */
            total: number;
        };
        /** SearchDownloadRequest */
        SearchDownloadRequest: {
            /** Search Term */
            search_term: string;
            /** Filename */
            filename?: string | null;
            /**
             * Normalize
             * @default false
             */
            normalize: boolean;
            /**
             * Effect Type
             * @default clean
             */
            effect_type: string;
            /**
             * Volume Boost
             * @default 4
             */
            volume_boost: number;
            /** Title */
            title?: string | null;
            /** Artist */
            artist?: string | null;
            /** Album */
            album?: string | null;
        };
        /** SearchLyricsRequest */
        SearchLyricsRequest: {
            /** Album */
            album: string;
            /** File */
            file: string;
            /**
             * Source
             * @description Provider ID; omit to search all enabled sources
             */
            source?: string | null;
            /**
             * Plainonly
             * @description Return only plain lyrics to synchronize to the audio
             * @default false
             */
            plainOnly: boolean;
        };
        /** SearchRequest */
        SearchRequest: {
            /** Termino */
            termino: string;
        };
        /** SearchResponse */
        SearchResponse: {
            /** Query */
            query: {
                [key: string]: unknown;
            };
            /** Providers */
            providers: string[];
            /** Candidates */
            candidates: components["schemas"]["CandidateResponse"][];
        };
        /** SecretCounts */
        SecretCounts: {
            /** Sources */
            sources: number;
            /** Apppasswords */
            appPasswords: number | null;
        };
        /** SecretKeyStatus */
        SecretKeyStatus: {
            /** Fingerprint */
            fingerprint: string | null;
            /**
             * Source
             * @enum {string}
             */
            source: "credentials-dir" | "key-file" | "generated";
        };
        /** SecretRequest */
        SecretRequest: {
            /**
             * Value
             * Format: password
             */
            value: string;
        };
        /** SecretStatus */
        SecretStatus: {
            /** Name */
            name: string;
            /**
             * State
             * @enum {string}
             */
            state: "falta" | "guardada" | "rechazada" | "ilegible";
            /**
             * Source
             * @enum {string}
             */
            source: "app" | "env" | "file";
            /** Locked */
            locked: boolean;
            /** Verifiedat */
            verifiedAt: string | null;
            /** Reason */
            reason: string | null;
        };
        /** SecretsStatus */
        SecretsStatus: {
            /** Secrets */
            secrets: components["schemas"]["SecretStatus"][];
            key: components["schemas"]["SecretKeyStatus"];
            counts: components["schemas"]["SecretCounts"];
        };
        /** ServerConfigResponse */
        ServerConfigResponse: {
            machine: components["schemas"]["Machine"];
            restart: components["schemas"]["RestartState"];
            activity: components["schemas"]["Activity"];
            /** Groups */
            groups: components["schemas"]["Group"][];
        };
        /**
         * ServerNameRequest
         * @description ``PUT /api/server/name``. Validated by ``instance.clean_nest_name``.
         */
        ServerNameRequest: {
            /** Name */
            name: string;
        };
        /** ServerNameResponse */
        ServerNameResponse: {
            /** Name */
            name: string;
        };
        /** ServerNetworkResponse */
        ServerNetworkResponse: {
            /** Lan */
            lan: string[];
            /**
             * Lannetworks
             * @default []
             */
            lanNetworks: string[];
            tailscale: components["schemas"]["TailscaleAddressModel"] | null;
            /** Externalurl */
            externalUrl: string | null;
            /** Route */
            route?: ("tailscale" | "wireguard" | "domain" | "local") | null;
            outside?: components["schemas"]["OutsideVisitModel"] | null;
        };
        /** ServerStorageResponse */
        ServerStorageResponse: {
            /** Dataroot */
            dataRoot: string;
            disk: components["schemas"]["DiskModel"];
            /** Music */
            music: number;
            /** Stems */
            stems: number;
            /** Other */
            other: number;
        };
        /**
         * SetLabelRequest
         * @description ``POST /api/me/label`` and ``POST /api/users/{id}/label``.
         *
         *     The name the household sees for an account — «Robin» — as opposed to
         *     ``username``, the name typed into a sign-in form. Same bound as
         *     :class:`CreateUserRequest`, because it is the same field.
         */
        SetLabelRequest: {
            /** Label */
            label: string;
        };
        /** SetOffsetRequest */
        SetOffsetRequest: {
            /** Offsetms */
            offsetMs: number;
            /** Expectedrevision */
            expectedRevision?: string | null;
        };
        /**
         * SetUsernameRequest
         * @description ``POST /api/me/username``. The name the caller's own account signs in with.
         *
         *     No ``userId``, for the reason in :class:`AddDeviceRequest`: the account comes
         *     off the credential the request arrived with. The bound here is generous
         *     because the real rules live in ``identity.clean_username`` and produce a
         *     sentence the user can act on; a pydantic length error would only say "string
         *     too long".
         */
        SetUsernameRequest: {
            /** Username */
            username: string;
        };
        /** Setting */
        Setting: {
            /** Disabledreason */
            disabledReason?: ("no-engine" | "no-cgroup" | "memory") | null;
            /** Disabledmessage */
            disabledMessage?: string | null;
            /** Key */
            key: string;
            /** Value */
            value: unknown;
            /** Default */
            default: unknown;
            /**
             * Source
             * @enum {string}
             */
            source: "default" | "env" | "app";
            /** Editable */
            editable: boolean;
            /** Needsrestart */
            needsRestart: boolean;
            /**
             * Secret
             * @default false
             */
            secret: boolean;
            /**
             * Kind
             * @enum {string}
             */
            kind: "int" | "bool" | "choice" | "path" | "text" | "list";
            /** Version */
            version?: string | null;
            /** Binarysource */
            binarySource?: ("env" | "system" | "bundled") | null;
            /** Configured */
            configured?: boolean | null;
            /** Min */
            min?: number | null;
            /** Max */
            max?: number | null;
            /** Suggestedmax */
            suggestedMax?: number | null;
            /** Unit */
            unit?: string | null;
            /** Choices */
            choices?: string[] | null;
            /** Pendingvalue */
            pendingValue?: unknown;
        };
        /**
         * SetupStateRequest
         * @description ``PUT /api/server/setup``.
         */
        SetupStateRequest: {
            /** Done */
            done: boolean;
        };
        /** SetupStateResponse */
        SetupStateResponse: {
            /** Setupdone */
            setupDone: boolean;
        };
        /** SignInCodePollResponse */
        SignInCodePollResponse: {
            credential?: components["schemas"]["CreateDeviceResponse"] | null;
            /** Declined */
            declined?: boolean | null;
        };
        /** SignInCodeRequest */
        SignInCodeRequest: {
            /** Username */
            username?: string | null;
            /** Devicelabel */
            deviceLabel: string;
        };
        /** SignInCodeResponse */
        SignInCodeResponse: {
            /** Code */
            code: string;
            /** Secret */
            secret: string;
            /** Expiresin */
            expiresIn: number;
            /** Pollinterval */
            pollInterval: number;
        };
        /** SignInRequestResponse */
        SignInRequestResponse: {
            /** Id */
            id: string;
            /** Devicelabel */
            deviceLabel: string;
            /**
             * Network
             * @enum {string}
             */
            network: "local" | "vpn";
            /** Createdat */
            createdAt: string;
            /** Expiresat */
            expiresAt: string;
            /** Code */
            code: string;
        };
        /** SignInRequestsResponse */
        SignInRequestsResponse: {
            /** Requests */
            requests: components["schemas"]["SignInRequestResponse"][];
        };
        /**
         * SignInResponse
         * @description ``GET /api/users/{id}/sign-in``: the name another account signs in with, for its owner.
         *
         *     ``null`` when the account was made with only a token, so a reset has to give it a
         *     username in the same call. Kept off the account listing, whose rows shipped clients
         *     decode strictly.
         */
        SignInResponse: {
            /** Username */
            username: string | null;
            /** Haspassword */
            hasPassword: boolean;
        };
        /** SkipUpdateRequest */
        SkipUpdateRequest: {
            /** Version */
            version: string;
        };
        /** SkippedTrack */
        SkippedTrack: {
            /** Relpath */
            relPath: string;
            /**
             * Reason
             * @enum {string}
             */
            reason: "missing" | "ghost" | "outside" | "current" | "failed";
        };
        /** SourceActionRequest */
        SourceActionRequest: {
            /** Id */
            id: string;
            /** Value */
            value?: unknown;
        };
        /** SourceStatus */
        SourceStatus: {
            /** Revision */
            revision?: string | null;
            /** Facts */
            facts?: components["schemas"]["Fact"][];
            /** Actions */
            actions?: components["schemas"]["Action"][];
            /** Toggles */
            toggles?: components["schemas"]["Toggle"][];
            /** Warning */
            warning?: string | null;
        };
        /** SpotifyAuthorizeUrl */
        SpotifyAuthorizeUrl: {
            /** Url */
            url: string;
        };
        /** SpotifyConfigRequest */
        SpotifyConfigRequest: {
            /**
             * Client Id
             * @default
             */
            client_id: string;
            /**
             * Client Secret
             * @default
             */
            client_secret: string;
        };
        /** SpotifyPlaylistRequest */
        SpotifyPlaylistRequest: {
            /** Tracks */
            tracks: components["schemas"]["SpotifyTrack"][];
            /** Carpeta */
            carpeta?: string | null;
            /**
             * Normalize
             * @default false
             */
            normalize: boolean;
            /**
             * Effect Type
             * @default clean
             */
            effect_type: string;
            /**
             * Volume Boost
             * @default 4
             */
            volume_boost: number;
        };
        /** SpotifySearchRequest */
        SpotifySearchRequest: {
            /** Query */
            query: string;
            /**
             * Limit
             * @default 10
             */
            limit: number;
        };
        /** SpotifyTrack */
        SpotifyTrack: {
            /** Title */
            title: string;
            /** Artist */
            artist?: string | null;
            /** Album */
            album?: string | null;
            /** Track Number */
            track_number?: number | null;
            /** Duration Ms */
            duration_ms?: number | null;
            /** Album Images */
            album_images?: {
                [key: string]: unknown;
            }[] | null;
        };
        /** StemsAgentState */
        StemsAgentState: {
            /** Online */
            online: boolean;
            /** Lastseen */
            lastSeen?: string | null;
            /** Name */
            name?: string | null;
        };
        /** StemsClaimRequest */
        StemsClaimRequest: {
            agent?: components["schemas"]["AgentIdentity"] | null;
        };
        /** StemsClaimResponse */
        StemsClaimResponse: {
            /**
             * Id
             * @description The lease id: what heartbeat and result present
             */
            id: string;
            /** Jobid */
            jobId: string;
            /** Album */
            album: string;
            /** File */
            file: string;
            /** Mediapath */
            mediaPath: string;
            /** Model */
            model: string;
            /** Attempt */
            attempt: number;
        };
        /** StemsDeleteAllResponse */
        StemsDeleteAllResponse: {
            /** Removed */
            removed: number;
        };
        /** StemsDeleteResponse */
        StemsDeleteResponse: {
            /** Success */
            success: boolean;
            /** Removed */
            removed: boolean;
        };
        /** StemsHeartbeatRequest */
        StemsHeartbeatRequest: {
            agent?: components["schemas"]["AgentIdentity"] | null;
            /** Id */
            id: string;
            /**
             * Phase
             * @description worker phase key; Spanish keys are mapped to the wire's English ones
             */
            phase?: string | null;
            /**
             * Progress
             * @description 0–100
             */
            progress?: number | null;
        };
        /** StemsHeartbeatResponse */
        StemsHeartbeatResponse: {
            /** Stop */
            stop: boolean;
            /** Reason */
            reason?: ("replaced" | "lease-lost" | "cancelled" | "revoked" | "too-old") | null;
            /** Minimum */
            minimum?: string | null;
        };
        /** StemsJobRow */
        StemsJobRow: {
            /** Album */
            album: string;
            /** File */
            file: string;
            /** Status */
            status: string;
            /** Phase */
            phase?: string | null;
            /** Progress */
            progress?: number | null;
            /** Error */
            error?: string | null;
            /** Requestedat */
            requestedAt?: string | null;
            /** Updatedat */
            updatedAt?: string | null;
            /**
             * Kind
             * @default stems
             */
            kind: string;
            /** Needs */
            needs?: string[];
            /** Offeredat */
            offeredAt?: number | null;
            /** Leasedby */
            leasedBy?: string | null;
            /** Result */
            result?: {
                [key: string]: unknown;
            } | null;
            /** Waitreason */
            waitReason?: ("no-helper" | "no-capable-helper" | "helpers-offline" | "helpers-busy") | null;
        };
        /** StemsJobsResponse */
        StemsJobsResponse: {
            /** Oldestat */
            oldestAt?: number | null;
            /** Waitreason */
            waitReason?: ("no-helper" | "no-capable-helper" | "helpers-offline" | "helpers-busy") | null;
            /** Jobs */
            jobs: components["schemas"]["StemsJobRow"][];
            agent: components["schemas"]["StemsAgentState"];
            /**
             * Mode
             * @description agent | local — who runs the engine
             */
            mode: string;
        };
        /** StemsListResponse */
        StemsListResponse: {
            /** Splits */
            splits: components["schemas"]["StemsSplitRow"][];
        };
        /** StemsPendingResponse */
        StemsPendingResponse: {
            /** Status */
            status: string;
            /**
             * Phase
             * @description queued · claimed · decoding · separating · beats · chops · encoding · uploading · failed
             */
            phase?: string | null;
            /** Progress */
            progress?: number | null;
            /** Error */
            error?: string | null;
            agent: components["schemas"]["StemsAgentState"];
        };
        /** StemsRequest */
        StemsRequest: {
            /** Album */
            album: string;
            /** File */
            file: string;
            /**
             * Model
             * @description htdemucs (the only one today)
             */
            model?: string | null;
            /**
             * Priority
             * @default now
             * @enum {string}
             */
            priority: "now" | "background";
        };
        /** StemsRequestResponse */
        StemsRequestResponse: {
            /**
             * Status
             * @description queued | running | ready | failed | skipped (background disabled)
             */
            status: string;
            /** Jobid */
            jobId?: string | null;
        };
        /** StemsResultResponse */
        StemsResultResponse: {
            /** Accepted */
            accepted: boolean;
            /** Reason */
            reason?: "lease-lost" | null;
            /** Status */
            status?: string | null;
            /** Requeued */
            requeued?: boolean | null;
        };
        /** StemsSplitRow */
        StemsSplitRow: {
            /** Album */
            album: string;
            /** File */
            file: string;
            /** Title */
            title: string;
            /** Artist */
            artist: string;
            /** Albumtitle */
            albumTitle: string;
            /** Createdat */
            createdAt: string | null;
            /** Stale */
            stale: boolean;
            /**
             * Sizebytes
             * @description Stored bytes of song.json and the four Ogg stems; stat only
             */
            sizeBytes: number;
        };
        /** SuccessResponse */
        SuccessResponse: {
            /** Success */
            success: boolean;
        };
        /** SummaryHelper */
        SummaryHelper: {
            /** Online */
            online: boolean;
            /** Name */
            name: string | null;
            /** Working */
            working: boolean;
        };
        /** TagBatch */
        TagBatch: {
            /** Set */
            set: {
                [key: string]: string | number | boolean | string[] | null;
            };
            /** Rev */
            rev?: string | null;
            /**
             * Id3Version
             * @default 4
             */
            id3Version: number;
            /** Items */
            items: components["schemas"]["TagItem"][];
        };
        /** TagConflict */
        TagConflict: {
            detail: components["schemas"]["TagConflictDetail"];
        };
        /** TagConflictDetail */
        TagConflictDetail: {
            /** Reason */
            reason: string;
            current?: components["schemas"]["TagView"] | null;
        };
        /** TagEditDetail */
        TagEditDetail: {
            /** Id */
            id: string;
            /** Kind */
            kind: string;
            /** Undoes */
            undoes: string | null;
            /** Principal */
            principal: string;
            /** State */
            state: string;
            /** Plan Hash */
            plan_hash: string | null;
            /** Created At */
            created_at: number;
            /** Applied At */
            applied_at: number | null;
            /** Job Id */
            job_id: string | null;
            /** Expires At */
            expires_at: number;
            /** Rows */
            rows: components["schemas"]["TagEditRow"][];
        } & {
            [key: string]: unknown;
        };
        /** TagEditRow */
        TagEditRow: {
            /** Edit Id */
            edit_id: string;
            /** Idx */
            idx: number;
            /** Rel Before */
            rel_before: string;
            /** Rel After */
            rel_after: string;
            /** Identity Before */
            identity_before: string | components["schemas"]["TagFileIdentity"] | null;
            /** Identity After */
            identity_after: string | components["schemas"]["TagFileIdentity"] | null;
            /** Fields Before */
            fields_before: {
                [key: string]: string | number | boolean | string[] | null;
            } | null;
            /** Fields After */
            fields_after: {
                [key: string]: string | number | boolean | string[] | null;
            } | null;
            /** Recycle Path */
            recycle_path: string | null;
            /** State */
            state: string;
            /** Reason */
            reason: string | null;
            /** Newer Edit Id */
            newer_edit_id: string | null;
        } & {
            [key: string]: unknown;
        };
        /** TagFileIdentity */
        TagFileIdentity: {
            /** Size */
            size: number;
            /** Mtimens */
            mtimeNs: number;
            /** Tagsha */
            tagSha: string;
        } & {
            [key: string]: unknown;
        };
        /** TagItem */
        TagItem: {
            /** Relpath */
            relPath: string;
            /** Rev */
            rev: string;
        };
        /** TagPatch */
        TagPatch: {
            /** Set */
            set: {
                [key: string]: string | number | boolean | string[] | null;
            };
            /** Rev */
            rev?: string | null;
            /**
             * Id3Version
             * @default 4
             */
            id3Version: number;
        };
        /** TagView */
        TagView: {
            /** Fields */
            fields: {
                [key: string]: string | number | boolean | string[] | null;
            };
            /** Format */
            format: string;
            /** Writable */
            writable: boolean;
            /** Reason */
            reason?: string | null;
            /** Rev */
            rev: string;
        };
        /** TailscaleAddressModel */
        TailscaleAddressModel: {
            /** Ip */
            ip: string;
            /** Name */
            name: string | null;
            /** Url */
            url: string;
        };
        /** Toggle */
        Toggle: {
            /** Id */
            id: string;
            /** Label */
            label: string;
            /** Value */
            value: boolean;
        };
        /** Track */
        Track: {
            /** Title */
            title: string;
            /**
             * Artist
             * @default
             */
            artist: string;
            /** Album */
            album?: string | null;
            /** Provider Id */
            provider_id?: string | null;
            /** Duration S */
            duration_s?: number | null;
            /** Track Number */
            track_number?: number | null;
            /** Cover Url */
            cover_url?: string | null;
            /** Youtube Url */
            youtube_url?: string | null;
            /** Isrc */
            isrc?: string | null;
            /** Replaces */
            replaces?: string | null;
            /** Album Artist */
            album_artist?: string | null;
            /** Track Total */
            track_total?: number | null;
            /** Disc Number */
            disc_number?: number | null;
            /** Disc Total */
            disc_total?: number | null;
            /** Compilation */
            compilation?: boolean | null;
            /** Genre */
            genre?: string | null;
            /** Year */
            year?: number | null;
            /** Recording Mbid */
            recording_mbid?: string | null;
            /** Release Mbid */
            release_mbid?: string | null;
            /** Release Group Mbid */
            release_group_mbid?: string | null;
            /** Artist Mbid */
            artist_mbid?: string | string[] | null;
        };
        /**
         * TrackMutationResponse
         * @description ``POST /api/delete-track`` and ``POST /api/update-tags``.
         *
         *     ``path`` is the *resolved* path the server acted on, not the one the client
         *     sent — that is the point of echoing it back.
         */
        TrackMutationResponse: {
            /** Success */
            success: boolean;
            /** Path */
            path: string;
        };
        /** TrackRef */
        TrackRef: {
            /** Album */
            album: string;
            /** File */
            file: string;
        };
        /**
         * TrackWithMetadata
         * @description One track inside ``GET /api/listar-albums-con-metadata``.
         *
         *     ⚠ ``url_path`` is built from the album's **directory** name, not from
         *     ``album`` above it: the two differ for a large share of a real library and
         *     the mismatch fails silently (a 404 on media, a working list). Clients must
         *     parse it rather than reconstruct it — and must strip the query string before
         *     parsing, since a token can ride along.
         */
        TrackWithMetadata: {
            /** Title */
            title: string;
            /** Artist */
            artist: string;
            /** Duration */
            duration?: number | null;
            /** Path */
            path: string;
            /** Url Path */
            url_path: string;
            /** Relpath */
            relPath?: string | null;
            /**
             * Missingfromnest
             * @default false
             */
            missingFromNest: boolean;
            /** Missingsince */
            missingSince?: string | null;
            /** Track Number */
            track_number?: number | null;
            /** Genre */
            genre?: string | null;
            /** Artists */
            artists?: string[];
            /** Genres */
            genres?: string[];
            /** Albumartist */
            albumArtist?: string | null;
            /** Albumartists */
            albumArtists?: string[];
            /** Discnumber */
            discNumber?: number | null;
            /** Compilation */
            compilation?: boolean | null;
            /** Year */
            year?: number | null;
            /** Titlesort */
            titleSort?: string | null;
            /** Artistsort */
            artistSort?: string | null;
            /** Albumsort */
            albumSort?: string | null;
            /** Albumartistsort */
            albumArtistSort?: string | null;
            /** Composersort */
            composerSort?: string | null;
            /** Dateadded */
            dateAdded?: number | null;
            /** Keyconfidence */
            keyConfidence?: number | null;
            /** Bpmconfidence */
            bpmConfidence?: number | null;
            /**
             * Bpmestimated
             * @default false
             */
            bpmEstimated: boolean;
            /**
             * Keyestimated
             * @default false
             */
            keyEstimated: boolean;
            /**
             * Analysisstate
             * @default none
             * @enum {string}
             */
            analysisState: "analyzed" | "queued" | "failed" | "none";
            /**
             * Bpmfixed
             * @default false
             */
            bpmFixed: boolean;
            /**
             * Keyfixed
             * @default false
             */
            keyFixed: boolean;
            /** Keysource */
            keySource?: ("fixed" | "tag" | "computed") | null;
            /** Bpmsource */
            bpmSource?: ("fixed" | "tag" | "computed") | null;
            /** Bpm */
            bpm?: number | null;
            /** Key */
            key?: string | null;
            /** Mood */
            mood?: string | null;
            /** Arousal */
            arousal?: number | null;
            /** Analysis */
            analysis?: {
                [key: string]: unknown;
            } | null;
        };
        /** TranscribePendingRequest */
        TranscribePendingRequest: {
            /**
             * Isolatevocals
             * @default true
             */
            isolateVocals: boolean;
        };
        /** TranscribeRequest */
        TranscribeRequest: {
            /** Tracks */
            tracks?: components["schemas"]["TranscribeTrack"][];
            /**
             * Isolatevocals
             * @default true
             */
            isolateVocals: boolean;
        };
        /** TranscribeTrack */
        TranscribeTrack: {
            /** Album */
            album: string;
            /** File */
            file: string;
            /** Text */
            text?: string | null;
        };
        /** UndoResult */
        UndoResult: {
            /** Editid */
            editId: string;
        };
        /**
         * UnreadMemberResponse
         * @description An archive member that produced no playlists, and what it looked like.
         *
         *     ``category`` is one of ``ignored`` / ``known`` / ``unrecognized`` /
         *     ``unreadable``; only ``unrecognized`` means the layout changed under us.
         *     ``detail`` quotes a *shape* and never a value — an export is somebody's
         *     listening history and this report is meant to be pasteable into a bug.
         */
        UnreadMemberResponse: {
            /** Filename */
            filename: string;
            /** Sizebytes */
            sizeBytes: number;
            /** Category */
            category: string;
            /** Detail */
            detail: string;
        };
        /**
         * UpdatePlaylistTracksResponse
         * @description ``PUT /api/playlists/{name}/tracks``.
         */
        UpdatePlaylistTracksResponse: {
            /** Success */
            success: boolean;
            playlist: components["schemas"]["UpdatedPlaylistCounts"];
        };
        /** UpdateResponse */
        UpdateResponse: {
            /** Checking */
            checking: boolean;
            /** Current */
            current: string;
            /** Latest */
            latest: string | null;
            /** Skipped */
            skipped: string | null;
            /** Updateavailable */
            updateAvailable: boolean;
            /** Releaseurl */
            releaseUrl: string | null;
            /**
             * Install
             * @enum {string}
             */
            install: "script" | "compose" | "unraid" | "systemd" | "desktop" | "unknown";
            /** Pinned */
            pinned: boolean;
            /** Command */
            command: string | null;
            /** Checkedat */
            checkedAt: string | null;
            /** Lasterror */
            lastError: ("unreachable" | "rate-limited" | "no-release" | "bad-response") | null;
        };
        /** UpdateTagsRequest */
        UpdateTagsRequest: {
            /** Path */
            path: string;
            /** Title */
            title?: string | null;
            /** Artist */
            artist?: string | null;
            /** Album */
            album?: string | null;
            /** Genre */
            genre?: string | null;
            /** Year */
            year?: number | null;
            /** Track Number */
            track_number?: number | null;
            /** Bpm */
            bpm?: number | null;
        };
        /**
         * UpdatedPlaylistCounts
         * @description The body nested in ``PUT /api/playlists/{name}/tracks``. snake_case.
         */
        UpdatedPlaylistCounts: {
            /** Name */
            name: string;
            /** Track Count */
            track_count: number;
            /** Total Duration */
            total_duration?: number | null;
        };
        /** UploadFile */
        UploadFile: {
            /** Id */
            id: string;
            /** Sha256 */
            sha256: string;
            /** Name */
            name: string;
            /** Bytes */
            bytes: number;
            /** Title */
            title?: string | null;
            /** Artist */
            artist?: string | null;
            /** Duration S */
            duration_s?: number | null;
        };
        /** UploadItemView */
        UploadItemView: {
            /** Id */
            id: string;
            /** Sha256 */
            sha256: string;
            /** Name */
            name: string;
            /** Bytes */
            bytes: number;
            /** Offset */
            offset: number;
            /**
             * State
             * @enum {string}
             */
            state: "por-subir" | "ya-estaba" | "subiendo" | "importando" | "agregada" | "no-apta" | "fallida";
            /** Reason */
            reason?: ("no-es-audio" | "archivo-danado" | "muy-grande" | "sin-espacio" | "fallo-subida") | null;
            /**
             * Duplicate
             * @default false
             */
            duplicate: boolean;
            /**
             * Already
             * @default false
             */
            already: boolean;
        };
        /** UploadSpace */
        UploadSpace: {
            /** Freebytes */
            freeBytes: number;
            /** Floorbytes */
            floorBytes: number;
        };
        /** UploadVlcRequest */
        UploadVlcRequest: {
            /** Paths */
            paths: string[];
            /** Vlc Ip */
            vlc_ip: string;
        };
        /**
         * UserListResponse
         * @description ``GET /api/users`` — everyone who holds a token. Never the tokens.
         */
        UserListResponse: {
            /** Users */
            users: components["schemas"]["UserPublic"][];
        };
        /**
         * UserPublic
         * @description A token holder, metadata only. Mirrors ``UserRecord.public()`` exactly.
         *
         *     ⚠ The timestamps are **ISO-8601 UTC strings** (``2026-08-20T11:02:31Z``),
         *     not the POSIX floats the music and playlist payloads use. They are typed
         *     ``str`` rather than ``datetime`` on purpose: a ``datetime`` would round-trip
         *     through Pydantic and come back spelled ``+00:00``, changing bytes on the
         *     wire for no gain.
         */
        UserPublic: {
            /** Id */
            id: string;
            /** Label */
            label: string;
            /** Role */
            role: string;
            /** Createdat */
            createdAt?: string | null;
            /** Lastseenat */
            lastSeenAt?: string | null;
        };
        /**
         * UserTrackRow
         * @description One row of the calling principal's library. Mirrors ``UserTrack.public()``.
         *
         *     ``relPath`` is two clean segments — ``album/file`` — relative to the shared
         *     music root, never an absolute path and never a URL. It is the key for every
         *     other route on this surface.
         *
         *     ⚠ Both timestamps are **ISO-8601 UTC strings**, matching the identity rows
         *     above and *not* the POSIX floats a playlist or a track carries. Typing them
         *     as floats is the one mistake this file has already made once.
         *
         *     ``lastPlayedAt`` is coarse by design: the store batches play writes, so it
         *     will usually predate the request reading it. It is not a clock.
         */
        UserTrackRow: {
            /** Relpath */
            relPath: string;
            /** Addedat */
            addedAt: string;
            /** Liked */
            liked: boolean;
            /** Offline */
            offline: boolean;
            /** Playcount */
            playCount: number;
            /** Lastplayedat */
            lastPlayedAt?: string | null;
        };
        /**
         * UsernameResponse
         * @description ``POST /api/me/username`` — the name as it was stored.
         *
         *     Echoed back **as typed**, not as matched: the store keeps the case the
         *     person chose and compares ignoring it, so a client that assumed its own
         *     input was what got saved would show ``Robin`` where the server holds ``robin``.
         *     One key, and it stays one key — this is the only place on the whole surface a
         *     username appears, deliberately: ``UserPublic`` is pinned by
         *     ``tests/integration/test_response_contracts.py`` and decoded by two shipped
         *     clients, so the field could not be added there without breaking them.
         */
        UsernameResponse: {
            /** Username */
            username: string;
        };
        /** ValidationError */
        ValidationError: {
            /** Location */
            loc: (string | number)[];
            /** Message */
            msg: string;
            /** Error Type */
            type: string;
            /** Input */
            input?: unknown;
            /** Context */
            ctx?: Record<string, never>;
        };
        /** Values */
        Values: {
            /** Key */
            key: string | null;
            /** Bpm */
            bpm: number | null;
        };
        /** WaitingOn */
        WaitingOn: {
            /** Name */
            name: string;
            /** State */
            state: string;
        };
        /**
         * WaveformResponse
         * @description ``GET /api/waveform/{album}/{filename}``.
         */
        WaveformResponse: {
            /** Waveform */
            waveform: number[];
            /** Samples */
            samples: number;
            /** Track */
            track: string;
        };
        /**
         * WavesurferPeaksResponse
         * @description ``GET /api/wavesurfer-peaks/{album}/{filename}``.
         *
         *     The field names are not ours: this is the peaks-file layout a waveform
         *     widget in the renderer consumes directly, so ``data`` is a list *of
         *     channels*, each a list of samples, even though this backend always emits one.
         */
        WavesurferPeaksResponse: {
            /** Version */
            version: number;
            /** Channels */
            channels: number;
            /** Sample Rate */
            sample_rate: number;
            /** Samples Per Pixel */
            samples_per_pixel: number;
            /** Bits */
            bits: number;
            /** Length */
            length: number;
            /** Data */
            data: number[][];
        };
        /** WorkWindow */
        WorkWindow: {
            /** Days */
            days: number[];
            /** Startminute */
            startMinute: number;
            /** Endminute */
            endMinute: number;
        };
        /** WorkerJob */
        WorkerJob: {
            /** Title */
            title: string;
            /** Phase */
            phase?: string | null;
        };
        /** WorkerLimits */
        WorkerLimits: {
            /**
             * Pace
             * @default fast
             * @enum {string}
             */
            pace: "fast" | "gentle" | "off";
            /**
             * Paused
             * @default false
             */
            paused: boolean;
            window?: components["schemas"]["WorkWindow"] | null;
            /**
             * Onlycharging
             * @default false
             */
            onlyCharging: boolean;
            /**
             * Cpupercent
             * @default 50
             */
            cpuPercent: number;
            /**
             * Maxtempc
             * @default 85
             */
            maxTempC: number;
            /**
             * Resumetempc
             * @default 75
             */
            resumeTempC: number;
            /** Use */
            use?: {
                [key: string]: boolean;
            };
            /**
             * Installeverything
             * @default false
             */
            installEverything: boolean;
        };
        /** YouTubeSearchRequest */
        YouTubeSearchRequest: {
            /** Query */
            query: string;
            /**
             * Limit
             * @default 10
             */
            limit: number;
        };
        /** YouTubeSearchResponse */
        YouTubeSearchResponse: {
            /** Query */
            query: string;
            /** Results */
            results: components["schemas"]["YouTubeSearchResult"][];
        };
        /** YouTubeSearchResult */
        YouTubeSearchResult: {
            /** Id */
            id?: string | null;
            /** Url */
            url: string;
            /** Title */
            title?: string | null;
            /** Duration */
            duration?: number | null;
            /** Uploader */
            uploader?: string | null;
        };
        /** YoutubeDownloadRequest */
        YoutubeDownloadRequest: {
            /** Url */
            url: string;
            /** Filename */
            filename?: string | null;
            /** Nombre Archivo */
            nombre_archivo?: string | null;
            /**
             * Normalize
             * @default false
             */
            normalize: boolean;
            /**
             * Effect Type
             * @default clean
             */
            effect_type: string;
            /**
             * Volume Boost
             * @default 4
             */
            volume_boost: number;
        };
        /** YtdlpCookiesRequest */
        YtdlpCookiesRequest: {
            /**
             * Cookies From Browser
             * @default
             */
            cookies_from_browser: string;
            /**
             * Cookies File
             * @default
             */
            cookies_file: string;
        };
        /** YtdlpResponse */
        YtdlpResponse: {
            /** Version */
            version: string | null;
            /**
             * Channel
             * @default stable
             * @constant
             */
            channel: "stable";
            /** Updatedat */
            updatedAt: number | null;
            /** Lastcheckat */
            lastCheckAt: number | null;
            /** Autoupdate */
            autoUpdate: boolean;
            /** Agedays */
            ageDays: number | null;
            /** Stale */
            stale: boolean;
            /** Rolledbackfrom */
            rolledBackFrom?: string | null;
            /** Error */
            error?: string | null;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type SchemaAcquireRequest = components['schemas']['AcquireRequest'];
export type SchemaAcquireTrack = components['schemas']['AcquireTrack'];
export type SchemaAction = components['schemas']['Action'];
export type SchemaActionView = components['schemas']['ActionView'];
export type SchemaActivity = components['schemas']['Activity'];
export type SchemaAddDeviceRequest = components['schemas']['AddDeviceRequest'];
export type SchemaAddToLibraryResponse = components['schemas']['AddToLibraryResponse'];
export type SchemaAgentByeRequest = components['schemas']['AgentByeRequest'];
export type SchemaAgentClaimRequest = components['schemas']['AgentClaimRequest'];
export type SchemaAgentControlResponse = components['schemas']['AgentControlResponse'];
export type SchemaAgentHeartbeatRequest = components['schemas']['AgentHeartbeatRequest'];
export type SchemaAgentIdentity = components['schemas']['AgentIdentity'];
export type SchemaAgentResultRequest = components['schemas']['AgentResultRequest'];
export type SchemaAlbumNamesResponse = components['schemas']['AlbumNamesResponse'];
export type SchemaAlbumUrlRequest = components['schemas']['AlbumUrlRequest'];
export type SchemaAlbumWithMetadata = components['schemas']['AlbumWithMetadata'];
export type SchemaAlignLyricsRequest = components['schemas']['AlignLyricsRequest'];
export type SchemaAnalysisSummary = components['schemas']['AnalysisSummary'];
export type SchemaAnalysisTagsRequest = components['schemas']['AnalysisTagsRequest'];
export type SchemaAnalysisView = components['schemas']['AnalysisView'];
export type SchemaApproveSignInCodeRequest = components['schemas']['ApproveSignInCodeRequest'];
export type SchemaAttentionHelper = components['schemas']['AttentionHelper'];
export type SchemaAttentionProgress = components['schemas']['AttentionProgress'];
export type SchemaAttentionResponse = components['schemas']['AttentionResponse'];
export type SchemaAttentionVersion = components['schemas']['AttentionVersion'];
export type SchemaBackupEntry = components['schemas']['BackupEntry'];
export type SchemaBackupsResponse = components['schemas']['BackupsResponse'];
export type SchemaBaseDirRequest = components['schemas']['BaseDirRequest'];
export type SchemaBatch = components['schemas']['Batch'];
export type SchemaBatchPlay = components['schemas']['BatchPlay'];
export type SchemaBatchResult = components['schemas']['BatchResult'];
export type SchemaBatchView = components['schemas']['BatchView'];
export type SchemaBodyOpenFileApiOpenFilePost = components['schemas']['Body_open_file_api_open_file_post'];
export type SchemaBodyStemsAgentResultApiStemsAgentResultPost = components['schemas']['Body_stems_agent_result_api_stems_agent_result_post'];
export type SchemaCancion = components['schemas']['Cancion'];
export type SchemaCandidateResponse = components['schemas']['CandidateResponse'];
export type SchemaChangeEvent = components['schemas']['ChangeEvent'];
export type SchemaChangePasswordRequest = components['schemas']['ChangePasswordRequest'];
export type SchemaCheck = components['schemas']['Check'];
export type SchemaCheckView = components['schemas']['CheckView'];
export type SchemaClaimRequest = components['schemas']['ClaimRequest'];
export type SchemaClearLogRequest = components['schemas']['ClearLogRequest'];
export type SchemaClearLogResponse = components['schemas']['ClearLogResponse'];
export type SchemaClearView = components['schemas']['ClearView'];
export type SchemaComputeSummary = components['schemas']['ComputeSummary'];
export type SchemaComputedValues = components['schemas']['ComputedValues'];
export type SchemaComputer = components['schemas']['Computer'];
export type SchemaConfigChanges = components['schemas']['ConfigChanges'];
export type SchemaCoverSize = components['schemas']['CoverSize'];
export type SchemaCreateDeviceResponse = components['schemas']['CreateDeviceResponse'];
export type SchemaCreatePlaylistResponse = components['schemas']['CreatePlaylistResponse'];
export type SchemaCreateUserRequest = components['schemas']['CreateUserRequest'];
export type SchemaCreateUserResponse = components['schemas']['CreateUserResponse'];
export type SchemaCreatedPlaylist = components['schemas']['CreatedPlaylist'];
export type SchemaDecision = components['schemas']['Decision'];
export type SchemaDeletePlaylistResponse = components['schemas']['DeletePlaylistResponse'];
export type SchemaDeleteTrackRequest = components['schemas']['DeleteTrackRequest'];
export type SchemaDeleteTrackResponse = components['schemas']['DeleteTrackResponse'];
export type SchemaDeletionPreviewResponse = components['schemas']['DeletionPreviewResponse'];
export type SchemaDeviceListResponse = components['schemas']['DeviceListResponse'];
export type SchemaDeviceListRow = components['schemas']['DeviceListRow'];
export type SchemaDevicePublic = components['schemas']['DevicePublic'];
export type SchemaDiskModel = components['schemas']['DiskModel'];
export type SchemaDownloadAlbumRequest = components['schemas']['DownloadAlbumRequest'];
export type SchemaDownloadSongRequest = components['schemas']['DownloadSongRequest'];
export type SchemaDuplicateDifference = components['schemas']['DuplicateDifference'];
export type SchemaDuplicateFile = components['schemas']['DuplicateFile'];
export type SchemaDuplicateGroup = components['schemas']['DuplicateGroup'];
export type SchemaDuplicateJob = components['schemas']['DuplicateJob'];
export type SchemaDuplicateKeep = components['schemas']['DuplicateKeep'];
export type SchemaDuplicateList = components['schemas']['DuplicateList'];
export type SchemaEditResult = components['schemas']['EditResult'];
export type SchemaEffectiveValue = components['schemas']['EffectiveValue'];
export type SchemaEngineInstallRequest = components['schemas']['EngineInstallRequest'];
export type SchemaEngineInventory = components['schemas']['EngineInventory'];
export type SchemaEngineJobResponse = components['schemas']['EngineJobResponse'];
export type SchemaEntry = components['schemas']['Entry'];
export type SchemaEstimateRow = components['schemas']['EstimateRow'];
export type SchemaEstimatedCounts = components['schemas']['EstimatedCounts'];
export type SchemaEstimatesPage = components['schemas']['EstimatesPage'];
export type SchemaExportImportStartedResponse = components['schemas']['ExportImportStartedResponse'];
export type SchemaExportParseResponse = components['schemas']['ExportParseResponse'];
export type SchemaExportResolutionResponse = components['schemas']['ExportResolutionResponse'];
export type SchemaExportResolveCancelResponse = components['schemas']['ExportResolveCancelResponse'];
export type SchemaExportResolveStartedResponse = components['schemas']['ExportResolveStartedResponse'];
export type SchemaExportTrackListRequest = components['schemas']['ExportTrackListRequest'];
export type SchemaExportTrackRef = components['schemas']['ExportTrackRef'];
export type SchemaExportedPlaylistResponse = components['schemas']['ExportedPlaylistResponse'];
export type SchemaExportedTrackResponse = components['schemas']['ExportedTrackResponse'];
export type SchemaExtension = components['schemas']['Extension'];
export type SchemaExtensionsResponse = components['schemas']['ExtensionsResponse'];
export type SchemaExternalUrlRequest = components['schemas']['ExternalUrlRequest'];
export type SchemaExternalUrlResponse = components['schemas']['ExternalUrlResponse'];
export type SchemaFact = components['schemas']['Fact'];
export type SchemaFailureKind = components['schemas']['FailureKind'];
export type SchemaFetchSpotifyPlaylistRequest = components['schemas']['FetchSpotifyPlaylistRequest'];
export type SchemaFixedRequest = components['schemas']['FixedRequest'];
export type SchemaGeniusCredentialsRequest = components['schemas']['GeniusCredentialsRequest'];
export type SchemaGeniusCredentialsStatus = components['schemas']['GeniusCredentialsStatus'];
export type SchemaGroup = components['schemas']['Group'];
export type SchemaHttpValidationError = components['schemas']['HTTPValidationError'];
export type SchemaHealthCheck = components['schemas']['HealthCheck'];
export type SchemaHealthSong = components['schemas']['HealthSong'];
export type SchemaHealthSource = components['schemas']['HealthSource'];
export type SchemaHealthStat = components['schemas']['HealthStat'];
export type SchemaHealthStats = components['schemas']['HealthStats'];
export type SchemaHelloEvent = components['schemas']['HelloEvent'];
export type SchemaHelperBlockedReason = components['schemas']['HelperBlockedReason'];
export type SchemaHelperCapabilities = components['schemas']['HelperCapabilities'];
export type SchemaHelperClaimRequest = components['schemas']['HelperClaimRequest'];
export type SchemaHelperClaimResponse = components['schemas']['HelperClaimResponse'];
export type SchemaHelperHeartbeatRequest = components['schemas']['HelperHeartbeatRequest'];
export type SchemaHelperJob = components['schemas']['HelperJob'];
export type SchemaHelperResultResponse = components['schemas']['HelperResultResponse'];
export type SchemaHomeSnapshot = components['schemas']['HomeSnapshot'];
export type SchemaHostCpu = components['schemas']['HostCPU'];
export type SchemaHostFacts = components['schemas']['HostFacts'];
export type SchemaHostMemory = components['schemas']['HostMemory'];
export type SchemaHostOs = components['schemas']['HostOS'];
export type SchemaInstallRequest = components['schemas']['InstallRequest'];
export type SchemaInstallResponse = components['schemas']['InstallResponse'];
export type SchemaItemView = components['schemas']['ItemView'];
export type SchemaItemsView = components['schemas']['ItemsView'];
export type SchemaJobView = components['schemas']['JobView'];
export type SchemaJobsView = components['schemas']['JobsView'];
export type SchemaKeyExportRequest = components['schemas']['KeyExportRequest'];
export type SchemaKindPolicy = components['schemas']['KindPolicy'];
export type SchemaKindSummary = components['schemas']['KindSummary'];
export type SchemaKindUpdate = components['schemas']['KindUpdate'];
export type SchemaKnownSource = components['schemas']['KnownSource'];
export type SchemaKnownSourcesResponse = components['schemas']['KnownSourcesResponse'];
export type SchemaLabelResponse = components['schemas']['LabelResponse'];
export type SchemaLegacySource = components['schemas']['LegacySource'];
export type SchemaLegacySourcesResponse = components['schemas']['LegacySourcesResponse'];
export type SchemaLibraryHealthResponse = components['schemas']['LibraryHealthResponse'];
export type SchemaLibraryScanRequest = components['schemas']['LibraryScanRequest'];
export type SchemaLibraryScanStatus = components['schemas']['LibraryScanStatus'];
export type SchemaLibrarySummaryResponse = components['schemas']['LibrarySummaryResponse'];
export type SchemaLoginRequest = components['schemas']['LoginRequest'];
export type SchemaLyricsConfigRequest = components['schemas']['LyricsConfigRequest'];
export type SchemaLyricsConfigResponse = components['schemas']['LyricsConfigResponse'];
export type SchemaLyricsEngineResponse = components['schemas']['LyricsEngineResponse'];
export type SchemaLyricsJobsResponse = components['schemas']['LyricsJobsResponse'];
export type SchemaLyricsRecordResponse = components['schemas']['LyricsRecordResponse'];
export type SchemaLyricsStatesResponse = components['schemas']['LyricsStatesResponse'];
export type SchemaMacWaitingResponse = components['schemas']['MacWaitingResponse'];
export type SchemaMacWorker = components['schemas']['MacWorker'];
export type SchemaMachine = components['schemas']['Machine'];
export type SchemaMatchApplyRequest = components['schemas']['MatchApplyRequest'];
export type SchemaMatchApplyResult = components['schemas']['MatchApplyResult'];
export type SchemaMatchCandidate = components['schemas']['MatchCandidate'];
export type SchemaMatchDiff = components['schemas']['MatchDiff'];
export type SchemaMatchFailure = components['schemas']['MatchFailure'];
export type SchemaMatchFile = components['schemas']['MatchFile'];
export type SchemaMatchPlan = components['schemas']['MatchPlan'];
export type SchemaMatchPlanRequest = components['schemas']['MatchPlanRequest'];
export type SchemaMatchPlanRow = components['schemas']['MatchPlanRow'];
export type SchemaMatchRequest = components['schemas']['MatchRequest'];
export type SchemaMatchSelection = components['schemas']['MatchSelection'];
export type SchemaMatchStarted = components['schemas']['MatchStarted'];
export type SchemaMatchView = components['schemas']['MatchView'];
export type SchemaMeResponse = components['schemas']['MeResponse'];
export type SchemaMissingAccount = components['schemas']['MissingAccount'];
export type SchemaMissingApply = components['schemas']['MissingApply'];
export type SchemaMissingApplyRow = components['schemas']['MissingApplyRow'];
export type SchemaMissingLibraryResponse = components['schemas']['MissingLibraryResponse'];
export type SchemaMissingListing = components['schemas']['MissingListing'];
export type SchemaMissingMatch = components['schemas']['MissingMatch'];
export type SchemaMissingOutcome = components['schemas']['MissingOutcome'];
export type SchemaMissingOutcomeRow = components['schemas']['MissingOutcomeRow'];
export type SchemaMissingPreview = components['schemas']['MissingPreview'];
export type SchemaMissingReferences = components['schemas']['MissingReferences'];
export type SchemaMissingRemoval = components['schemas']['MissingRemoval'];
export type SchemaMissingRow = components['schemas']['MissingRow'];
export type SchemaMissingSearch = components['schemas']['MissingSearch'];
export type SchemaMoveTrackRequest = components['schemas']['MoveTrackRequest'];
export type SchemaMyLibraryResponse = components['schemas']['MyLibraryResponse'];
export type SchemaMyOwnershipResponse = components['schemas']['MyOwnershipResponse'];
export type SchemaMyOwnershipVerdict = components['schemas']['MyOwnershipVerdict'];
export type SchemaOnboardedResponse = components['schemas']['OnboardedResponse'];
export type SchemaOutsideVisitModel = components['schemas']['OutsideVisitModel'];
export type SchemaOwnedTrackRef = components['schemas']['OwnedTrackRef'];
export type SchemaOwnershipQuery = components['schemas']['OwnershipQuery'];
export type SchemaOwnershipRequest = components['schemas']['OwnershipRequest'];
export type SchemaOwnershipResponse = components['schemas']['OwnershipResponse'];
export type SchemaOwnershipVerdictResponse = components['schemas']['OwnershipVerdictResponse'];
export type SchemaPasswordChangeResponse = components['schemas']['PasswordChangeResponse'];
export type SchemaPatchRequest = components['schemas']['PatchRequest'];
export type SchemaPauseRequest = components['schemas']['PauseRequest'];
export type SchemaPendingListResponse = components['schemas']['PendingListResponse'];
export type SchemaPendingTrackResponse = components['schemas']['PendingTrackResponse'];
export type SchemaPlayEventRow = components['schemas']['PlayEventRow'];
export type SchemaPlayHistoryResponse = components['schemas']['PlayHistoryResponse'];
export type SchemaPlayRequest = components['schemas']['PlayRequest'];
export type SchemaPlaylistCreateRequest = components['schemas']['PlaylistCreateRequest'];
export type SchemaPlaylistDetail = components['schemas']['PlaylistDetail'];
export type SchemaPlaylistItem = components['schemas']['PlaylistItem'];
export type SchemaPlaylistRemovalUpdate = components['schemas']['PlaylistRemovalUpdate'];
export type SchemaPlaylistRenameRequest = components['schemas']['PlaylistRenameRequest'];
export type SchemaPlaylistSummary = components['schemas']['PlaylistSummary'];
export type SchemaPlaylistTrackResponse = components['schemas']['PlaylistTrackResponse'];
export type SchemaPlaylistUrlImportRequest = components['schemas']['PlaylistUrlImportRequest'];
export type SchemaPlaysAccepted = components['schemas']['PlaysAccepted'];
export type SchemaPlaysBatch = components['schemas']['PlaysBatch'];
export type SchemaPollSignInCodeRequest = components['schemas']['PollSignInCodeRequest'];
export type SchemaProviderFormatResponse = components['schemas']['ProviderFormatResponse'];
export type SchemaProviderHealthResponse = components['schemas']['ProviderHealthResponse'];
export type SchemaProviderKind = components['schemas']['ProviderKind'];
export type SchemaProviderOrderRequest = components['schemas']['ProviderOrderRequest'];
export type SchemaProviderResponse = components['schemas']['ProviderResponse'];
export type SchemaProviderToggleRequest = components['schemas']['ProviderToggleRequest'];
export type SchemaProvidersResponse = components['schemas']['ProvidersResponse'];
export type SchemaRefreshFromSourceResponse = components['schemas']['RefreshFromSourceResponse'];
export type SchemaRefreshPlaylistResponse = components['schemas']['RefreshPlaylistResponse'];
export type SchemaRefreshedPlaylistCounts = components['schemas']['RefreshedPlaylistCounts'];
export type SchemaRelPathsRequest = components['schemas']['RelPathsRequest'];
export type SchemaRemoteRouteRequest = components['schemas']['RemoteRouteRequest'];
export type SchemaRemoteRouteResponse = components['schemas']['RemoteRouteResponse'];
export type SchemaRemovableSongs = components['schemas']['RemovableSongs'];
export type SchemaRemoveFromLibraryResponse = components['schemas']['RemoveFromLibraryResponse'];
export type SchemaRenameDeviceRequest = components['schemas']['RenameDeviceRequest'];
export type SchemaRenamePlaylistResponse = components['schemas']['RenamePlaylistResponse'];
export type SchemaRenamedPlaylist = components['schemas']['RenamedPlaylist'];
export type SchemaReplayGain = components['schemas']['ReplayGain'];
export type SchemaRequest = components['schemas']['Request'];
export type SchemaResetPasswordRequest = components['schemas']['ResetPasswordRequest'];
export type SchemaRestartRequest = components['schemas']['RestartRequest'];
export type SchemaRestartResponse = components['schemas']['RestartResponse'];
export type SchemaRestartState = components['schemas']['RestartState'];
export type SchemaRestoreLyricsMetadata = components['schemas']['RestoreLyricsMetadata'];
export type SchemaRetryDownloadRequest = components['schemas']['RetryDownloadRequest'];
export type SchemaRetryDownloadResponse = components['schemas']['RetryDownloadResponse'];
export type SchemaRetryRequest = components['schemas']['RetryRequest'];
export type SchemaRetrySelection = components['schemas']['RetrySelection'];
export type SchemaRevokeDeviceResponse = components['schemas']['RevokeDeviceResponse'];
export type SchemaRevokeUserResponse = components['schemas']['RevokeUserResponse'];
export type SchemaRunConflictDetail = components['schemas']['RunConflictDetail'];
export type SchemaRunConflictResponse = components['schemas']['RunConflictResponse'];
export type SchemaRunCounts = components['schemas']['RunCounts'];
export type SchemaRunPreview = components['schemas']['RunPreview'];
export type SchemaRunProgress = components['schemas']['RunProgress'];
export type SchemaRunRequest = components['schemas']['RunRequest'];
export type SchemaRunResponse = components['schemas']['RunResponse'];
export type SchemaRunView = components['schemas']['RunView'];
export type SchemaRunningWork = components['schemas']['RunningWork'];
export type SchemaSaveLyricsRequest = components['schemas']['SaveLyricsRequest'];
export type SchemaScanRequest = components['schemas']['ScanRequest'];
export type SchemaScanResponse = components['schemas']['ScanResponse'];
export type SchemaSearchDownloadRequest = components['schemas']['SearchDownloadRequest'];
export type SchemaSearchLyricsRequest = components['schemas']['SearchLyricsRequest'];
export type SchemaSearchRequest = components['schemas']['SearchRequest'];
export type SchemaSearchResponse = components['schemas']['SearchResponse'];
export type SchemaSecretCounts = components['schemas']['SecretCounts'];
export type SchemaSecretKeyStatus = components['schemas']['SecretKeyStatus'];
export type SchemaSecretRequest = components['schemas']['SecretRequest'];
export type SchemaSecretStatus = components['schemas']['SecretStatus'];
export type SchemaSecretsStatus = components['schemas']['SecretsStatus'];
export type SchemaServerConfigResponse = components['schemas']['ServerConfigResponse'];
export type SchemaServerNameRequest = components['schemas']['ServerNameRequest'];
export type SchemaServerNameResponse = components['schemas']['ServerNameResponse'];
export type SchemaServerNetworkResponse = components['schemas']['ServerNetworkResponse'];
export type SchemaServerStorageResponse = components['schemas']['ServerStorageResponse'];
export type SchemaSetLabelRequest = components['schemas']['SetLabelRequest'];
export type SchemaSetOffsetRequest = components['schemas']['SetOffsetRequest'];
export type SchemaSetUsernameRequest = components['schemas']['SetUsernameRequest'];
export type SchemaSetting = components['schemas']['Setting'];
export type SchemaSetupStateRequest = components['schemas']['SetupStateRequest'];
export type SchemaSetupStateResponse = components['schemas']['SetupStateResponse'];
export type SchemaSignInCodePollResponse = components['schemas']['SignInCodePollResponse'];
export type SchemaSignInCodeRequest = components['schemas']['SignInCodeRequest'];
export type SchemaSignInCodeResponse = components['schemas']['SignInCodeResponse'];
export type SchemaSignInRequestResponse = components['schemas']['SignInRequestResponse'];
export type SchemaSignInRequestsResponse = components['schemas']['SignInRequestsResponse'];
export type SchemaSignInResponse = components['schemas']['SignInResponse'];
export type SchemaSkipUpdateRequest = components['schemas']['SkipUpdateRequest'];
export type SchemaSkippedTrack = components['schemas']['SkippedTrack'];
export type SchemaSourceActionRequest = components['schemas']['SourceActionRequest'];
export type SchemaSourceStatus = components['schemas']['SourceStatus'];
export type SchemaSpotifyAuthorizeUrl = components['schemas']['SpotifyAuthorizeUrl'];
export type SchemaSpotifyConfigRequest = components['schemas']['SpotifyConfigRequest'];
export type SchemaSpotifyPlaylistRequest = components['schemas']['SpotifyPlaylistRequest'];
export type SchemaSpotifySearchRequest = components['schemas']['SpotifySearchRequest'];
export type SchemaSpotifyTrack = components['schemas']['SpotifyTrack'];
export type SchemaStemsAgentState = components['schemas']['StemsAgentState'];
export type SchemaStemsClaimRequest = components['schemas']['StemsClaimRequest'];
export type SchemaStemsClaimResponse = components['schemas']['StemsClaimResponse'];
export type SchemaStemsDeleteAllResponse = components['schemas']['StemsDeleteAllResponse'];
export type SchemaStemsDeleteResponse = components['schemas']['StemsDeleteResponse'];
export type SchemaStemsHeartbeatRequest = components['schemas']['StemsHeartbeatRequest'];
export type SchemaStemsHeartbeatResponse = components['schemas']['StemsHeartbeatResponse'];
export type SchemaStemsJobRow = components['schemas']['StemsJobRow'];
export type SchemaStemsJobsResponse = components['schemas']['StemsJobsResponse'];
export type SchemaStemsListResponse = components['schemas']['StemsListResponse'];
export type SchemaStemsPendingResponse = components['schemas']['StemsPendingResponse'];
export type SchemaStemsRequest = components['schemas']['StemsRequest'];
export type SchemaStemsRequestResponse = components['schemas']['StemsRequestResponse'];
export type SchemaStemsResultResponse = components['schemas']['StemsResultResponse'];
export type SchemaStemsSplitRow = components['schemas']['StemsSplitRow'];
export type SchemaSuccessResponse = components['schemas']['SuccessResponse'];
export type SchemaSummaryHelper = components['schemas']['SummaryHelper'];
export type SchemaTagBatch = components['schemas']['TagBatch'];
export type SchemaTagConflict = components['schemas']['TagConflict'];
export type SchemaTagConflictDetail = components['schemas']['TagConflictDetail'];
export type SchemaTagEditDetail = components['schemas']['TagEditDetail'];
export type SchemaTagEditRow = components['schemas']['TagEditRow'];
export type SchemaTagFileIdentity = components['schemas']['TagFileIdentity'];
export type SchemaTagItem = components['schemas']['TagItem'];
export type SchemaTagPatch = components['schemas']['TagPatch'];
export type SchemaTagView = components['schemas']['TagView'];
export type SchemaTailscaleAddressModel = components['schemas']['TailscaleAddressModel'];
export type SchemaToggle = components['schemas']['Toggle'];
export type SchemaTrack = components['schemas']['Track'];
export type SchemaTrackMutationResponse = components['schemas']['TrackMutationResponse'];
export type SchemaTrackRef = components['schemas']['TrackRef'];
export type SchemaTrackWithMetadata = components['schemas']['TrackWithMetadata'];
export type SchemaTranscribePendingRequest = components['schemas']['TranscribePendingRequest'];
export type SchemaTranscribeRequest = components['schemas']['TranscribeRequest'];
export type SchemaTranscribeTrack = components['schemas']['TranscribeTrack'];
export type SchemaUndoResult = components['schemas']['UndoResult'];
export type SchemaUnreadMemberResponse = components['schemas']['UnreadMemberResponse'];
export type SchemaUpdatePlaylistTracksResponse = components['schemas']['UpdatePlaylistTracksResponse'];
export type SchemaUpdateResponse = components['schemas']['UpdateResponse'];
export type SchemaUpdateTagsRequest = components['schemas']['UpdateTagsRequest'];
export type SchemaUpdatedPlaylistCounts = components['schemas']['UpdatedPlaylistCounts'];
export type SchemaUploadFile = components['schemas']['UploadFile'];
export type SchemaUploadItemView = components['schemas']['UploadItemView'];
export type SchemaUploadSpace = components['schemas']['UploadSpace'];
export type SchemaUploadVlcRequest = components['schemas']['UploadVlcRequest'];
export type SchemaUserListResponse = components['schemas']['UserListResponse'];
export type SchemaUserPublic = components['schemas']['UserPublic'];
export type SchemaUserTrackRow = components['schemas']['UserTrackRow'];
export type SchemaUsernameResponse = components['schemas']['UsernameResponse'];
export type SchemaValidationError = components['schemas']['ValidationError'];
export type SchemaValues = components['schemas']['Values'];
export type SchemaWaitingOn = components['schemas']['WaitingOn'];
export type SchemaWaveformResponse = components['schemas']['WaveformResponse'];
export type SchemaWavesurferPeaksResponse = components['schemas']['WavesurferPeaksResponse'];
export type SchemaWorkWindow = components['schemas']['WorkWindow'];
export type SchemaWorkerJob = components['schemas']['WorkerJob'];
export type SchemaWorkerLimits = components['schemas']['WorkerLimits'];
export type SchemaYouTubeSearchRequest = components['schemas']['YouTubeSearchRequest'];
export type SchemaYouTubeSearchResponse = components['schemas']['YouTubeSearchResponse'];
export type SchemaYouTubeSearchResult = components['schemas']['YouTubeSearchResult'];
export type SchemaYoutubeDownloadRequest = components['schemas']['YoutubeDownloadRequest'];
export type SchemaYtdlpCookiesRequest = components['schemas']['YtdlpCookiesRequest'];
export type SchemaYtdlpResponse = components['schemas']['YtdlpResponse'];
export type $defs = Record<string, never>;
export interface operations {
    events_api_events_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description SSE: hello carries bootId and visible revisions on every connection; change carries an area nudge with a monotonic id. Last-Event-ID is not replayed: resync displayed data using hello. One stream per client, shared by all its screens. Heartbeat comments every 15 seconds. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": components["schemas"]["HelloEvent"] | components["schemas"]["ChangeEvent"];
                };
            };
        };
    };
    listar_albums_api_listar_albums_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AlbumNamesResponse"];
                };
            };
        };
    };
    listar_albums_con_metadata_api_listar_albums_con_metadata_get: {
        parameters: {
            query?: {
                /** @description Inline each cover as a base64 data URI. Set false to get URLs only. */
                covers?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AlbumWithMetadata"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    serve_cover_api_media__album__cover_jpg_get: {
        parameters: {
            query?: {
                size?: components["schemas"]["CoverSize"] | null;
                /** @description Cover revision from the album listing; a match enables immutable caching. */
                v?: string | null;
            };
            header?: never;
            path: {
                album: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    serve_audio_api_media__album___filename__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                album: string;
                filename: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_waveform_api_waveform__album___filename__get: {
        parameters: {
            query?: {
                samples?: number;
            };
            header?: never;
            path: {
                album: string;
                filename: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WaveformResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_wavesurfer_peaks_api_wavesurfer_peaks__album___filename__get: {
        parameters: {
            query?: {
                samples?: number;
            };
            header?: never;
            path: {
                album: string;
                filename: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WavesurferPeaksResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_track_api_delete_track_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeleteTrackRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeleteTrackResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    move_track_api_library_move_track_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MoveTrackRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TrackMutationResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_tags_api_update_tags_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateTagsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TrackMutationResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    check_ownership_api_library_ownership_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OwnershipRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OwnershipResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    summary_api_analysis_summary_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AnalysisSummary"];
                };
            };
        };
    };
    estimates_api_analysis_estimates_get: {
        parameters: {
            query?: {
                after?: string | null;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EstimatesPage"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_run_api_analysis_runs_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RunRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunResponse"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunConflictResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    preview_run_api_analysis_runs_preview_get: {
        parameters: {
            query?: {
                mode?: "new" | "outdated" | "all";
                scope?: "library" | "selection" | "song";
                relPaths?: string[];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunPreview"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunConflictResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    replaygain_api_analysis__album___file__replaygain_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                album: string;
                file: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReplayGain"] | null;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    read_api_analysis__relPath__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                relPath: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AnalysisView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    fixed_api_analysis__relPath__fixed_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                relPath: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FixedRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AnalysisView"];
                };
            };
            /** @description Revision conflict; current row */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AnalysisView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    scan_status_api_library_scan_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryScanStatus"];
                };
            };
        };
    };
    request_scan_api_library_scan_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LibraryScanRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryScanStatus"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    library_health_api_library_health_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryHealthResponse"];
                };
            };
        };
    };
    batch_api_library_tags_batch_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TagBatch"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    read_api_library_tags__relPath__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                relPath: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TagView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    edit_api_library_tags__relPath__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                relPath: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TagPatch"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EditResult"];
                };
            };
            /** @description File changed; current tags when available */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TagConflict"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    history_api_library_edits_get: {
        parameters: {
            query?: {
                after?: string | null;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    detail_api_library_edits__editId__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                editId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TagEditDetail"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    undo_api_library_edits__editId__undo_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                editId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UndoResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    listing_api_library_missing_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MissingListing"];
                };
            };
        };
    };
    preview_api_library_missing_preview_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MissingSearch"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MissingPreview"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    apply_api_library_missing_apply_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MissingApply"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MissingOutcome"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    remove_api_library_missing_remove_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MissingRemoval"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MissingOutcome"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    start_api_library_match_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MatchRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MatchStarted"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    view_api_library_match__jobId__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                jobId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MatchView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    cancel_api_library_match__jobId__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                jobId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MatchView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    plan_api_library_match__jobId__plan_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                jobId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MatchPlanRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MatchPlan"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    apply_api_library_edits__planId__apply_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                planId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MatchApplyRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MatchApplyResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    listing_api_library_duplicates_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DuplicateList"];
                };
            };
        };
    };
    scan_api_library_duplicates_scan_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DuplicateJob"];
                };
            };
        };
    };
    keeper_api_library_duplicates__groupId__keeper_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                groupId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DuplicateKeep"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DuplicateList"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    dismiss_api_library_duplicates__groupId__dismiss_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                groupId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DuplicateList"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_requests_api_acquisition_requests_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    request_acquisition_api_acquisition_requests_post: {
        parameters: {
            query?: never;
            header?: {
                "idempotency-key"?: string | null;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Request"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    clear_requests_api_acquisition_requests_clear_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    clear_request_api_acquisition_requests__id__clear_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: number;
                    };
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_request_api_acquisition_requests__id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    cancel_request_api_acquisition_requests__id__cancel_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    retry_request_api_acquisition_requests__id__retry_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["RetrySelection"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    upload_space_api_uploads_space_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UploadSpace"];
                };
            };
        };
    };
    check_uploads_api_uploads_check_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Check"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CheckView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_batch_api_uploads_batches_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Batch"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_batch_api_uploads_batches__id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    start_batch_api_uploads_batches__id__start_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Decision"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stop_batch_api_uploads_batches__id__stop_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    retry_batch_api_uploads_batches__id__retry_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    fail_upload_api_uploads_batches__id__files__sha__fail_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                sha: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    upload_offset_api_uploads_batches__id__files__sha__head: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                sha: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    upload_chunk_api_uploads_batches__id__files__sha__patch: {
        parameters: {
            query?: never;
            header: {
                "upload-offset": number;
                "upload-checksum"?: string | null;
            };
            path: {
                id: string;
                sha: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Request Entity Too Large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
            /** @description Additional Response */
            460: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Insufficient Storage */
            507: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    download_album_song_api_download_album_song_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DownloadAlbumRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    download_single_song_api_download_single_song_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DownloadSongRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    download_youtube_url_api_download_youtube_url_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["YoutubeDownloadRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    download_search_api_download_search_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SearchDownloadRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    search_spotify_tracks_api_search_spotify_tracks_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SpotifySearchRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    download_spotify_playlist_api_download_spotify_playlist_post: {
        parameters: {
            query?: {
                dir?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SpotifyPlaylistRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    fetch_spotify_playlist_api_fetch_spotify_playlist_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FetchSpotifyPlaylistRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    import_playlist_url_api_import_playlist_url_post: {
        parameters: {
            query?: {
                dir?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlaylistUrlImportRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_active_downloads_api_downloads_active_get: {
        parameters: {
            query?: {
                /** @description Also return jobs that finished within this many seconds */
                include_finished_seconds?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_download_progress_api_download_progress__progress_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                progress_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stream_download_progress_api_download_progress_stream__progress_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                progress_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    youtube_search_api_downloads_youtube_search_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["YouTubeSearchRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["YouTubeSearchResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    retry_download_api_downloads_retry_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RetryDownloadRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RetryDownloadResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    download_api_download_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DownloadAlbumRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    spotify_status_api_spotify_status_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    spotify_login_api_spotify_login_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    spotify_authorize_url_api_spotify_authorize_url_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SpotifyAuthorizeUrl"];
                };
            };
        };
    };
    spotify_callback_api_spotify_callback_get: {
        parameters: {
            query?: {
                code?: string | null;
                state?: string | null;
                error?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    spotify_disconnect_api_spotify_disconnect_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    buscar_cover_api_buscar_cover_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AlbumUrlRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    buscar_album_info_api_buscar_album_info_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AlbumUrlRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    buscar_canciones_api_buscar_canciones_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SearchRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    buscar_api_buscar_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AlbumUrlRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_playlists_api_playlists_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlaylistSummary"][];
                };
            };
        };
    };
    create_playlist_api_playlists_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlaylistCreateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreatePlaylistResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_playlist_api_playlists__name__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlaylistDetail"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_playlist_api_playlists__name__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeletePlaylistResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    rename_playlist_api_playlists__name__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlaylistRenameRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RenamePlaylistResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_playlist_tracks_api_playlists__name__tracks_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlaylistItem"][];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UpdatePlaylistTracksResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    refresh_playlist_from_source_api_refresh_playlist__name__post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RefreshFromSourceResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    refresh_playlist_api_playlists__name__refresh_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RefreshPlaylistResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    parse_spotify_export_upload_api_playlists_spotify_export_parse_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExportParseResponse"];
                };
            };
        };
    };
    resolve_spotify_export_tracks_api_playlists_spotify_export_resolve_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExportTrackListRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExportResolveStartedResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_spotify_export_resolution_api_playlists_spotify_export_resolve__progress_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                progress_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExportResolutionResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    cancel_spotify_export_resolution_api_playlists_spotify_export_resolve__progress_id__cancel_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                progress_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExportResolveCancelResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    import_spotify_export_tracks_api_playlists_spotify_export_import_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExportTrackListRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExportImportStartedResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    upload_selected_vlc_api_upload_selected_vlc_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UploadVlcRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    upload_audio_vlc_api_upload_audio_vlc_post: {
        parameters: {
            query: {
                vlc_ip: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_dashboard_endpoint_api_dashboard_get: {
        parameters: {
            query?: {
                refresh?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_album_api_browse_album__provider___album_id__get: {
        parameters: {
            query?: {
                refresh?: boolean;
            };
            header?: never;
            path: {
                provider: string;
                album_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_artist_api_browse_artist__provider___artist_id__get: {
        parameters: {
            query?: {
                refresh?: boolean;
            };
            header?: never;
            path: {
                provider: string;
                artist_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_playlist_api_browse_playlist__provider___playlist_id__get: {
        parameters: {
            query?: {
                refresh?: boolean;
            };
            header?: never;
            path: {
                provider: string;
                playlist_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_genre_api_browse_genre__provider___genre_id__get: {
        parameters: {
            query?: {
                refresh?: boolean;
            };
            header?: never;
            path: {
                provider: string;
                genre_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    search_api_browse_search_get: {
        parameters: {
            query: {
                /** @description Free-text catalog query */
                q: string;
                /** @description Autocomplete while typing; full search on submit */
                mode?: "typing" | "full";
                /** @description Categories to search: artists, albums, tracks, playlists */
                types?: string[] | null;
                limit?: number;
                /** @description Force a provider; default is the user's order */
                provider?: string | null;
                refresh?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    acquire_api_browse_acquire_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AcquireRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    lyrics_jobs_api_lyrics_jobs_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LyricsJobsResponse"];
                };
            };
        };
    };
    lyrics_pending_api_lyrics_pending_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PendingListResponse"];
                };
            };
        };
    };
    lyrics_states_api_lyrics_states_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LyricsStatesResponse"];
                };
            };
        };
    };
    lyrics_scan_api_lyrics_scan_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ScanRequest"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScanResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    lyrics_search_api_lyrics_search_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SearchLyricsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SearchResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_lyrics_config_api_lyrics_config_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LyricsConfigResponse"];
                };
            };
        };
    };
    put_lyrics_config_api_lyrics_config_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LyricsConfigRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LyricsConfigResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    lyrics_engine_status_api_lyrics_engine_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    lyrics_engine_remove_api_lyrics_engine_remove_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EngineInstallRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    lyrics_engine_install_api_lyrics_engine_install_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["EngineInstallRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    align_lyrics_api_lyrics_align_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AlignLyricsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EngineJobResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    lyrics_transcribe_api_lyrics_transcribe_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TranscribeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EngineJobResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    lyrics_transcribe_pending_api_lyrics_transcribe_pending_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TranscribePendingRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EngineJobResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    lyrics_transcribe_cancel_api_lyrics_transcribe__progress_id__cancel_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                progress_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    lyrics_agent_claim_api_lyrics_agent_claim_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentClaimRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description No eligible work or helper already leased */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    lyrics_agent_heartbeat_api_lyrics_agent_heartbeat_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentHeartbeatRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    lyrics_agent_bye_api_lyrics_agent_bye_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentByeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentControlResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    lyrics_agent_result_api_lyrics_agent_result_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentResultRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    put_lyrics_offset_api_lyrics__album___file__offset_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                album: string;
                file: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetOffsetRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LyricsRecordResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_lyrics_api_lyrics__album___file__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                album: string;
                file: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LyricsRecordResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    put_lyrics_api_lyrics__album___file__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                album: string;
                file: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SaveLyricsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LyricsRecordResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_lyrics_api_lyrics__album___file__delete: {
        parameters: {
            query?: {
                expectedRevision?: string | null;
            };
            header?: never;
            path: {
                album: string;
                file: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stems_request_api_stems_request_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StemsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StemsRequestResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stems_list_api_stems_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StemsListResponse"];
                };
            };
        };
    };
    stems_delete_all_api_stems_delete: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StemsDeleteAllResponse"];
                };
            };
        };
    };
    stems_jobs_api_stems_jobs_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StemsJobsResponse"];
                };
            };
        };
    };
    stems_agent_claim_api_stems_agent_claim_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["StemsClaimRequest"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StemsClaimResponse"] | components["schemas"]["AgentControlResponse"];
                };
            };
            /** @description Nothing queued */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stems_agent_heartbeat_api_stems_agent_heartbeat_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StemsHeartbeatRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StemsHeartbeatResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stems_agent_result_api_stems_agent_result_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["Body_stems_agent_result_api_stems_agent_result_post"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StemsResultResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stems_get_api_stems__album___file__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                album: string;
                file: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Queued, running or failed */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StemsPendingResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stems_delete_api_stems__album___file__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                album: string;
                file: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StemsDeleteResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stems_audio_api_stems__album___file___stem__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                album: string;
                file: string;
                stem: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    claim_api_helpers_claim_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HelperClaimRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HelperClaimResponse"] | components["schemas"]["AgentControlResponse"];
                };
            };
            /** @description No eligible work */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    heartbeat_api_helpers_jobs__id__heartbeat_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HelperHeartbeatRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentControlResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    result_api_helpers_jobs__id__result_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Lease */
                    lease: string;
                    /**
                     * Ok
                     * @default true
                     */
                    ok?: boolean;
                    /** Items */
                    items?: {
                        [key: string]: unknown;
                    }[] | null;
                    /** Error */
                    error?: string | null;
                    /**
                     * Final
                     * @default true
                     */
                    final?: boolean;
                    /** Lrc */
                    lrc?: string | null;
                    /** Source */
                    source?: string | null;
                    /** Accel */
                    accel?: ("mlx" | "cuda" | "cpu") | null;
                    /** Fallbackreason */
                    fallbackReason?: ("oom" | "driver") | null;
                    /** Gpu */
                    gpu?: string | null;
                    /** Lineconfidence */
                    lineConfidence?: number[] | null;
                    /** Lowlines */
                    lowLines?: number[] | null;
                };
                "multipart/form-data": {
                    lease: string;
                    /** @default true */
                    ok?: boolean;
                    error?: string;
                    /** @default false */
                    final?: boolean;
                    /** Format: binary */
                    "song.json"?: string;
                    /** Format: binary */
                    drums?: string;
                    /** Format: binary */
                    bass?: string;
                    /** Format: binary */
                    vocals?: string;
                    /** Format: binary */
                    other?: string;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HelperResultResponse"];
                };
            };
            /** @description song.json exceeds 4 MB or a stem exceeds 128 MB */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Invalid result or missing parts */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    bye_api_helpers_bye_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentByeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentControlResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    summary_api_compute_summary_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ComputeSummary"];
                };
            };
        };
    };
    update_kind_api_compute_kinds__kind__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                kind: "align" | "transcribe" | "stems" | "analysis";
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["KindUpdate"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KindPolicy"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_computer_api_compute_computers__identity__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                identity: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkerLimits"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkerLimits"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    pause_api_compute_pause_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PauseRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PauseRequest"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    own_limits_api_helpers_limits_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkerLimits"];
                };
            };
        };
    };
    list_jobs_api_jobs_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobsView"];
                };
            };
        };
    };
    clear_jobs_api_jobs_clear_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ClearView"];
                };
            };
        };
    };
    clear_job_api_jobs__job_id__clear_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ClearView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    job_items_api_jobs__job_id__items_get: {
        parameters: {
            query?: {
                state?: string | null;
            };
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ItemsView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    cancel_job_api_jobs__job_id__cancel_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActionView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    retry_job_api_jobs__job_id__retry_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["RetryRequest"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActionView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    genius_credentials_status_api_config_genius_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GeniusCredentialsStatus"];
                };
            };
        };
    };
    set_genius_credentials_api_config_genius_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GeniusCredentialsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GeniusCredentialsStatus"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_genius_credentials_api_config_genius_delete: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GeniusCredentialsStatus"];
                };
            };
        };
    };
    update_ytdlp_api_providers_youtube_ytdlp_update_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["YtdlpResponse"];
                };
            };
        };
    };
    retry_provider_api_providers__provider_id__retry_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                provider_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderHealthResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_providers_api_providers_get: {
        parameters: {
            query?: {
                kind?: components["schemas"]["ProviderKind"] | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProvidersResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    set_provider_enabled_api_providers__provider_id__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                provider_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProviderToggleRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    set_provider_order_api_providers__kind__order_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                kind: components["schemas"]["ProviderKind"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProviderOrderRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProvidersResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    missing_sources_api_sources_missing_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LegacySourcesResponse"];
                };
            };
        };
    };
    list_known_sources_api_sources_known_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KnownSourcesResponse"];
                };
            };
        };
    };
    install_source_api_sources_install_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InstallRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InstallResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    source_action_api_sources__id__action_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SourceActionRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SourceStatus"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_source_api_sources__id__update_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InstallResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    remove_source_api_sources__id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: boolean;
                    };
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    whoami_api_me_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MeResponse"];
                };
            };
        };
    };
    read_attention_api_me_attention_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AttentionResponse"];
                };
            };
        };
    };
    list_my_devices_api_me_devices_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeviceListResponse"];
                };
            };
        };
    };
    add_my_device_api_me_devices_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AddDeviceRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateDeviceResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    add_my_api_key_api_me_devices_api_key_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AddDeviceRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateDeviceResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    add_my_app_password_api_me_devices_app_password_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AddDeviceRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateDeviceResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    revoke_my_device_api_me_devices__device_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RevokeDeviceResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    rename_my_device_api_me_devices__device_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RenameDeviceRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeviceListRow"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    login_api_login_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LoginRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateDeviceResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    revoke_user_device_api_users__user_id__devices__device_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
                device_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RevokeDeviceResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    set_my_username_api_me_username_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetUsernameRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UsernameResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    set_my_label_api_me_label_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetLabelRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LabelResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    change_my_password_api_me_password_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ChangePasswordRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PasswordChangeResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    claim_server_api_claim_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ClaimRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateUserResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_users_api_users_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserListResponse"];
                };
            };
        };
    };
    create_user_api_users_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateUserRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateUserResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_user_devices_api_users__user_id__devices_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeviceListResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    set_user_label_api_users__user_id__label_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetLabelRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LabelResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    deletion_preview_api_users__user_id__deletion_preview_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeletionPreviewResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    revoke_user_api_users__user_id__delete: {
        parameters: {
            query?: {
                songs?: boolean;
            };
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RevokeUserResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    reset_account_password_api_users__user_id__password_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResetPasswordRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PasswordChangeResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    complete_account_onboarding_api_me_onboarded_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OnboardedResponse"];
                };
            };
        };
    };
    request_sign_in_code_api_sign_in_code_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SignInCodeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SignInCodeResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    poll_sign_in_code_api_sign_in_code_poll_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PollSignInCodeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SignInCodePollResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    approve_sign_in_code_api_me_sign_in_code_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ApproveSignInCodeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SuccessResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_sign_in_requests_api_me_sign_in_requests_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SignInRequestsResponse"];
                };
            };
        };
    };
    approve_sign_in_request_api_me_sign_in_requests__request_id__approve_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                request_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SuccessResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    decline_sign_in_request_api_me_sign_in_requests__request_id__decline_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                request_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SuccessResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    inspect_sign_in_code_api_me_sign_in_code__code__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                code: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SignInRequestResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    decline_typed_sign_in_code_api_me_sign_in_code__code__decline_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                code: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SuccessResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    account_sign_in_api_users__user_id__sign_in_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SignInResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    my_library_api_me_library_get: {
        parameters: {
            query?: {
                accountId?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MyLibraryResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    add_to_my_library_api_me_library_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RelPathsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AddToLibraryResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    remove_from_my_library_api_me_library_delete: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RelPathsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoveFromLibraryResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_my_row_api_me_library_patch: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PatchRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserTrackRow"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    missing_library_api_me_library_missing_get: {
        parameters: {
            query?: {
                accountId?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MissingLibraryResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    record_play_api_me_plays_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlayRequest"] | components["schemas"]["PlaysBatch"] | components["schemas"]["BatchPlay"][];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserTrackRow"] | components["schemas"]["PlaysAccepted"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    play_history_api_me_plays_history_get: {
        parameters: {
            query?: {
                from?: string | null;
                to?: string | null;
                after?: string | null;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlayHistoryResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    check_my_ownership_api_me_library_ownership_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RelPathsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MyOwnershipResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    health_api_health_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    list_extensions_api_extensions_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExtensionsResponse"];
                };
            };
        };
    };
    server_status_api_status_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    set_setup_state_api_server_setup_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetupStateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SetupStateResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    library_summary_api_library_summary_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibrarySummaryResponse"];
                };
            };
        };
    };
    set_server_name_api_server_name_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ServerNameRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServerNameResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    server_network_api_server_network_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServerNetworkResponse"];
                };
            };
        };
    };
    set_remote_route_api_server_remote_route_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RemoteRouteRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteRouteResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    server_host_api_server_host_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HostFacts"];
                };
            };
        };
    };
    server_storage_api_server_storage_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServerStorageResponse"];
                };
            };
        };
    };
    set_external_url_api_server_external_url_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExternalUrlRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExternalUrlResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    ping_api_ping_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    set_basedir_api_set_basedir_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BaseDirRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_basedir_api_get_basedir_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    get_default_basedir_api_get_default_basedir_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    reset_basedir_api_reset_basedir_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    get_spotify_config_api_config_spotify_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    put_spotify_config_api_config_spotify_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SpotifyConfigRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_ytdlp_cookies_config_api_config_ytdlp_cookies_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    put_ytdlp_cookies_config_api_config_ytdlp_cookies_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["YtdlpCookiesRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_analysis_tags_config_api_config_analysis_tags_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    put_analysis_tags_config_api_config_analysis_tags_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AnalysisTagsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    open_file_api_open_file_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Body_open_file_api_open_file_post"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    clear_logs_api_logs_clear_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ClearLogRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ClearLogResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    read_logs_api_logs_get: {
        parameters: {
            query?: {
                file?: string;
                lines?: number;
                level?: string;
                q?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    status_api_server_secrets_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecretsStatus"];
                };
            };
        };
    };
    export_key_api_server_secrets_key_export_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["KeyExportRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    put_api_server_secrets__name__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SecretRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecretStatus"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_api_server_secrets__name__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecretStatus"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    config_api_server_config_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServerConfigResponse"];
                };
            };
        };
    };
    update_api_server_config_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfigChanges"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServerConfigResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    restart_api_server_restart_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RestartRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestartResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    read_update_api_server_update_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UpdateResponse"];
                };
            };
        };
    };
    check_update_api_server_update_check_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Stored state (floor or disabled) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UpdateResponse"];
                };
            };
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UpdateResponse"];
                };
            };
        };
    };
    skip_update_api_server_update_skip_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SkipUpdateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UpdateResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    restore_update_api_server_update_skip_delete: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UpdateResponse"];
                };
            };
        };
    };
    list_backups_api_server_backups_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BackupsResponse"];
                };
            };
        };
    };
    backup_now_api_server_backups_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BackupEntry"];
                };
            };
        };
    };
    root__get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    home_snapshot_api_me_home_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HomeSnapshot"];
                };
            };
        };
    };
}
