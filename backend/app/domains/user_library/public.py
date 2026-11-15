"""Public acquisition port: references and provenance, never household files."""
from app.utils.library_paths import rel_path_for
from .acquisition_links import restore_acquired


def restore(store, principal, root, path, old_rel, *, acquired):
    return restore_acquired(store, principal, root, path, old_rel, acquired=acquired)


def link(store, account_id, root, path, *, acquired):
    rel = rel_path_for(root, path)
    if rel is None:
        raise ValueError('unaddressable-track')
    store.add_many(account_id, [rel], acquired=acquired)
    return rel


def unlink_replaced(store, account_id, root, old, new):
    """Swap a member's reference only after their new reference exists."""
    old_rel, new_rel = rel_path_for(root, old), rel_path_for(root, new)
    if old_rel and new_rel and old_rel != new_rel and store.get(account_id, new_rel) is not None:
        store.remove_many(account_id, [old_rel])
