ObjC.import("AppKit");

function run(argv) {
  const [targetPath, iconPath] = argv;
  const image = $.NSImage.alloc.initWithContentsOfFile($(iconPath));
  if (!image) {
    throw new Error("Could not load launcher icon.");
  }

  const applied = $.NSWorkspace.sharedWorkspace.setIconForFileOptions(image, $(targetPath), 0);
  if (!applied) {
    throw new Error("Could not apply launcher icon.");
  }
}
