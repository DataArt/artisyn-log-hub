# Stuck chunked uploads can be traced

Hook 3.3.1 logs the upload id of every split upload (start, completion, restart, error, abandoned because the file changed) and keeps a larger `hook.log`; the Upload Queue tab no longer shows a wrong byte count for a partially uploaded file.
