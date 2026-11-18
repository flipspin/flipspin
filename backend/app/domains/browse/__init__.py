"""Catalog browsing: artist, album and playlist pages, plus catalog search.

The domain that turns a provider result from a link out to the provider's
website into a place inside KROBI. Everything here is read-only — acquiring a
track is the downloads domain's job, and browse hands it an identity to acquire
rather than a query string to guess with.
"""
