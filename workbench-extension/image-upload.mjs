export function installBrowserImageUpload({ createAttachments, createMenu, pickFiles }) {
  const style = document.createElement('style');
  style.textContent = `
    @media (hover: none), (pointer: coarse) {
      [class~="group/composer-attachment"] > button[class~="pointer-events-none"] {
        opacity: 1;
        pointer-events: auto;
        width: 28px;
        height: 28px;
        z-index: 1;
      }
    }
  `;
  document.head.append(style);
  const composers = new WeakMap();
  return {
    createAttachments(options) {
      const handlers = createAttachments(options);
      composers.set(handlers.addPickedFiles, {
        addImages: handlers.addImages,
        pickFiles: handlers.pickBrowserAttachments,
        enabled: options.supportsImageInputs,
      });
      return handlers;
    },
    createMenu(options) {
      const items = createMenu(options);
      const composer = composers.get(options.addPickedFiles);
      if (!composer) throw new Error('没有找到当前输入框的附件入口。');
      const [fileUpload] = createMenu({ ...options, pickFiles: composer.pickFiles });
      return [{
        id: 'upload-browser-images',
        label: '上传图片',
        icon: 'image',
        disabled: !composer.enabled,
        run: async () => {
          const generation = options.getAttachmentGeneration();
          const files = await pickFiles({ imagesOnly: true });
          if (files.length === 0 || options.getAttachmentGeneration() !== generation) return;
          composer.addImages(files, 'picker');
        },
      }, {
        ...fileUpload,
        id: 'upload-browser-files',
        label: '上传文件',
        icon: 'paperclip',
        disabled: !options.supportsFileAttachments,
      }, ...items];
    },
  };
}
