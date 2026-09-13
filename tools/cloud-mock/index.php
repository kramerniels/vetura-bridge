<?php
/**
 * Cloud mock — log-only. Upload this file (e.g. as test-pi.php) and set:
 *
 *   CLOUD_BASE_URL=https://your-host.example/test-pi.php
 *
 * The Pi POSTs /api/devices/register and GETs /api/devices/{id}/bootstrap
 * (PATH_INFO after this file). Nothing useful is returned; open this URL in a
 * browser to see the log.
 */
declare(strict_types=1);

$logFile = __DIR__ . '/cloud-mock.log';
$pathInfo = $_SERVER['PATH_INFO'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$uri = $_SERVER['REQUEST_URI'] ?? '';
$ip = $_SERVER['REMOTE_ADDR'] ?? '-';
$time = gmdate('Y-m-d H:i:s') . ' UTC';
$raw = file_get_contents('php://input');
$body = $raw === false ? '' : $raw;

$headers = [];
foreach ($_SERVER as $key => $value) {
    if (strpos($key, 'HTTP_') === 0 || $key === 'CONTENT_TYPE' || $key === 'CONTENT_LENGTH') {
        $headers[$key] = $value;
    }
}

$block = "===== {$time} =====\n";
$block .= "IP: {$ip}\n";
$block .= "METHOD: {$method}\n";
$block .= "URI: {$uri}\n";
$block .= "PATH_INFO: {$pathInfo}\n";
$block .= "HEADERS:\n";
foreach ($headers as $key => $value) {
    $block .= "  {$key}: {$value}\n";
}
$block .= "BODY:\n" . ($body === '' ? "(empty)\n" : $body . "\n");
$block .= "\n";

$wantsLogPage = $method === 'GET' && $pathInfo === '';
if (!$wantsLogPage) {
    @file_put_contents($logFile, $block, FILE_APPEND | LOCK_EX);
}

if ($wantsLogPage) {
    $log = is_readable($logFile) ? (string) file_get_contents($logFile) : "(no log yet — waiting for the Pi)\n";
    header('Content-Type: text/html; charset=utf-8');
    echo '<!DOCTYPE html><html><head><meta charset="utf-8">';
    echo '<meta http-equiv="refresh" content="3">';
    echo '<title>cloud-mock</title>';
    echo '<style>body{font:14px/1.4 ui-monospace,monospace;margin:1.5rem;background:#111;color:#ddd}';
    echo 'pre{white-space:pre-wrap;word-break:break-all}</style></head><body>';
    echo '<h1>cloud-mock</h1><p>Requests from the Pi (auto-refresh 3s).</p><pre>';
    echo htmlspecialchars($log, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    echo '</pre></body></html>';
    exit;
}

http_response_code(204);
