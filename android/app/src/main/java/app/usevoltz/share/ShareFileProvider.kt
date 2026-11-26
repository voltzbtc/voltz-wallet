package app.usevoltz.share

import androidx.core.content.FileProvider

// A subclass of its own, so the manifest merger never meets a library's FileProvider under the same
// class name. Its one root is the cache's share folder (res/xml/share_paths.xml).
class ShareFileProvider : FileProvider()
