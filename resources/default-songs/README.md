# Default songs

Anything placed here as a subdirectory is bundled into the installer and copied
into a new user's music folder on first run, so a fresh install has something to
play instead of an empty library.

⚠ **Only material we are allowed to redistribute may go in here.** Every file in
this directory ships inside every installer, to everyone who downloads the app.
A commercial track — even one file, even as a demo — makes each of those
downloads an act of infringement, and it is invisible once packaged: nothing in
the build warns about it, and the person who ships it is usually not the person
who added it.

Public domain, or a licence that explicitly permits redistribution (CC0 is the
safe choice). Keep the licence and its source next to the audio, so the next
person does not have to guess where it came from.

Empty is a perfectly good state: the installer skips this directory when it has
no album subdirectories, and the server skips the copy when there is nothing to
copy. A first run then simply starts with an empty library.
