// test/fetch-url.test.js — tests the pure logic behind the fetch_url tool
// (SSRF address filtering, HTML-to-text extraction) without making real
// network requests, which would be slow/flaky and hit external hosts.

require('./bootstrap');
const path = require('path');
const { suite, check } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { isPrivateAddress, stripHtmlToText } = require(path.join(OUT, 'agent/tools.js'));

function run() {
    suite('isPrivateAddress blocks loopback, private, and link-local ranges');
    {
        check('127.0.0.1 (loopback) is blocked', isPrivateAddress('127.0.0.1'));
        check('::1 (IPv6 loopback) is blocked', isPrivateAddress('::1'));
        check('10.x.x.x (private) is blocked', isPrivateAddress('10.1.2.3'));
        check('172.16.x.x (private) is blocked', isPrivateAddress('172.16.0.5'));
        check('172.31.x.x (private, top of range) is blocked', isPrivateAddress('172.31.255.255'));
        check('172.32.x.x (just outside the private range) is NOT blocked', !isPrivateAddress('172.32.0.1'));
        check('192.168.x.x (private) is blocked', isPrivateAddress('192.168.1.1'));
        check('169.254.169.254 (cloud metadata endpoint) is blocked', isPrivateAddress('169.254.169.254'));
        check('0.0.0.0 is blocked', isPrivateAddress('0.0.0.0'));
        check('a normal public IP is NOT blocked', !isPrivateAddress('93.184.216.34'));
        check('a malformed address fails closed (blocked)', isPrivateAddress('not-an-ip'));
    }

    suite('stripHtmlToText extracts readable content');
    {
        const html = '<html><head><style>.x{color:red}</style><script>alert(1)</script></head>' +
            '<body><h1>Title</h1><p>Hello &amp; welcome.</p><!-- a comment --></body></html>';
        const text = stripHtmlToText(html);
        check('script contents are removed', !text.includes('alert(1)'));
        check('style contents are removed', !text.includes('color:red'));
        check('comments are removed', !text.includes('a comment'));
        check('visible text survives', text.includes('Title') && text.includes('Hello & welcome.'));
    }
    {
        const text = stripHtmlToText('<p>Line one</p><p>Line two</p>');
        check('block-level tags become line breaks, not run-together text', text.includes('Line one') && text.includes('Line two') && text !== 'Line oneLine two');
    }
    {
        check('empty/tag-only input produces empty text', stripHtmlToText('<div></div>') === '');
    }
}

module.exports = { run };
