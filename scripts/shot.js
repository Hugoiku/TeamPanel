
ObjC.import('AppKit'); ObjC.import('WebKit'); ObjC.import('Foundation');
function run(argv) {
  var cwd = $.NSFileManager.defaultManager.currentDirectoryPath.js;
  var t = argv[0] || '0';
  var outName = argv[1] || 'docs/panel-preview.png';
  var explicitUrl = argv[2] || '';
  var evalJs = argv[3] || '';
  var w = 1560, h = 960;
  $.NSApplication.sharedApplication;
  $.NSApp.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var rect = $.NSMakeRect(0, 0, w, h);
  var win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(rect, 0, $.NSBackingStoreBuffered, false);
  var wv = $.WKWebView.alloc.initWithFrame(rect);
  win.contentView = wv;
  var urlStr = explicitUrl || encodeURI('file://' + cwd + '/dashboard/_shot.html');
  wv.loadRequest($.NSURLRequest.requestWithURL($.NSURL.URLWithString(urlStr)));
  var deadline = $.NSDate.dateWithTimeIntervalSinceNow(explicitUrl ? 7 : 5);
  while ($.NSDate.date.compare(deadline) < 0) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  }
  if (evalJs) {
    var jsOut = '';
    wv.evaluateJavaScriptCompletionHandler(evalJs, function (res, err) {
      jsOut = err ? ('ERR ' + err.localizedDescription.js) : String(res.js);
    });
    var je = $.NSDate.dateWithTimeIntervalSinceNow(2);
    while (!jsOut && $.NSDate.date.compare(je) < 0) {
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
    }
    console.log('JS: ' + jsOut);
  }
  var done = false, msg = '';
  var scfg = $.WKSnapshotConfiguration.alloc.init;
  scfg.rect = rect;
  wv.takeSnapshotWithConfigurationCompletionHandler(scfg, function (img, err) {
    try {
      if (!img) { msg = 'null image'; done = true; return; }
      var rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
      var png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
      png.writeToFileAtomically(cwd + '/' + outName, true);
      msg = 'written ' + outName + ' t=' + t;
    } catch (e) { msg = 'ERR ' + e; }
    done = true;
  });
  var d2 = $.NSDate.dateWithTimeIntervalSinceNow(8);
  while (!done && $.NSDate.date.compare(d2) < 0) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  }
  return msg;
}
