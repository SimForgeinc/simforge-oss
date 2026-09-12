import * as stylex from "@stylexjs/stylex";

export const styles = stylex.create({
  s_0: {"marginBottom":"0.5rem","fontSize":"0.75rem","fontWeight":600,"textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground
  s_1: {"display":"flex","right":0,"top":0,"height":"100%","flexDirection":"column","borderColor":"hsl(var(--border))","backgroundColor":"hsl(var(--background))"}, // animate-in slide-in-from-right-2 duration-200 ease-out absolute right-0 top-0 z-20 flex h-full w-80 flex-col border-l border-border bg-background shadow-xl
  s_2: {"display":"flex","flexShrink":0,"alignItems":"center","gap":"0.5rem","borderColor":"hsl(var(--border))","paddingInline":"0.75rem","paddingBlock":"0.625rem"}, // flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5
  s_7: {"overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","fontSize":"0.875rem","fontWeight":600,"lineHeight":1.375}, // truncate text-sm font-semibold leading-snug
  s_8: {"flex":"1 1 0%","overflowY":"auto","padding":"0.75rem"}, // flex-1 space-y-5 overflow-y-auto p-3
  s_22: {"color":"hsl(var(--muted-foreground))"}, // text-[11px] italic text-muted-foreground
  s_23: {"borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","padding":"0.5rem"}, // rounded-md border border-border p-2
  s_24: {"marginBottom":"0.25rem","display":"flex","alignItems":"center","justifyContent":"space-between"}, // mb-1 flex items-center justify-between
  s_25: {"fontWeight":500,"color":"hsl(var(--muted-foreground))"}, // text-[11px] font-medium text-muted-foreground
  s_26: {"color":"hsl(var(--muted-foreground))"}, // text-[11px] text-muted-foreground hover:text-destructive
  s_32: {"fontWeight":500,"color":"hsl(var(--primary))"}, // text-[11px] font-medium text-primary hover:underline
  s_37: {"marginBottom":"0.125rem","display":"block","color":"hsl(var(--muted-foreground))"}, // mb-0.5 block text-[11px] text-muted-foreground
  s_38: {"fontFamily":"ui-monospace, monospace","fontSize":"0.75rem"}, // h-7 font-mono text-xs
  s_39: {"marginLeft":"0.375rem","borderRadius":"0.5rem","paddingInline":"0.375rem","fontWeight":600}, // ml-1.5 rounded-full bg-yellow-950/60 px-1.5 py-px text-[10px] font-semibold text-yellow-300
  s_40: {"marginBottom":"0.5rem","display":"flex","gap":"0.25rem"}, // mb-2 flex flex-wrap gap-1
  s_41: {"display":"inline-flex","alignItems":"center","gap":"0.25rem","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","paddingInline":"0.375rem","paddingBlock":"0.125rem","fontFamily":"ui-monospace, monospace","fontSize":"0.75rem"}, // inline-flex items-center gap-1 rounded border border-yellow-500/40 bg-yellow-500/10 px-1.5 py-0.5 font-mono text-xs text-yellow-400
  s_42: {"display":"initial"}, // text-yellow-400/60 transition-colors hover:text-yellow-400
  s_44: {"display":"block","marginBottom":"0.5rem"}, // relative mb-2
  s_46: {"display":"block","left":0,"borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","backgroundColor":"hsl(var(--background))"}, // absolute left-0 top-8 z-20 w-72 rounded-md border border-border bg-background shadow-lg
  s_79: {"display":"flex","alignItems":"center","gap":"0.375rem","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.5rem","paddingBlock":"0.25rem"}, // flex items-center gap-1.5 rounded border border-border px-2 py-1
  s_81: {"minWidth":0,"flex":"1 1 0%","overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // min-w-0 flex-1 truncate text-xs text-muted-foreground
  s_83: {"flexShrink":0}, // shrink-0 text-muted-foreground/60 transition-colors hover:text-destructive
  s_89: {"display":"flex","alignItems":"center","gap":"0.375rem","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.5rem","paddingBlock":"0.375rem"}, // flex items-center gap-1.5 rounded border border-border px-2 py-1.5
  s_91: {"minWidth":0,"flex":"1 1 0%","overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","fontSize":"0.75rem"}, // min-w-0 flex-1 truncate text-xs
  s_92: {"height":"1.5rem","flexShrink":0,"paddingInline":"0.375rem","fontSize":"0.75rem"}, // h-6 w-20 shrink-0 px-1.5 text-xs
  s_95: {"marginBottom":"0.5rem","display":"flex","alignItems":"center","gap":"0.5rem","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","paddingInline":"0.5rem","paddingBlock":"0.375rem"}, // mb-2 flex items-center gap-2 rounded border border-emerald-500/30 bg-emerald-500/5 px-2 py-1.5
  s_96: {"flexShrink":0}, // size-3.5 shrink-0 text-emerald-500
  s_97: {"flex":"1 1 0%","fontSize":"0.75rem"}, // flex-1 text-xs text-emerald-400
  s_98: {"flexShrink":0,"fontSize":"0.75rem"}, // shrink-0 text-xs text-muted-foreground/60 transition-colors hover:text-destructive
  s_100: {"marginBottom":"0.5rem","display":"flex","alignItems":"center","gap":"0.5rem","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","paddingInline":"0.5rem","paddingBlock":"0.375rem"}, // mb-2 flex items-center gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5
  s_101: {"flexShrink":0}, // size-3.5 shrink-0 text-amber-500
  s_102: {"flex":"1 1 0%","fontSize":"0.75rem"}, // flex-1 text-xs text-amber-400
  s_105: {"marginBottom":"0.5rem","display":"flex","alignItems":"center","gap":"0.5rem","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.5rem","paddingBlock":"0.375rem"}, // mb-2 flex items-center gap-2 rounded border border-border px-2 py-1.5
  s_107: {"flex":"1 1 0%","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // flex-1 text-xs text-muted-foreground
  s_109: {"fontFamily":"ui-monospace, monospace","color":"hsl(var(--foreground))"}, // font-mono text-foreground
  s_110: {"flexShrink":0}, // shrink-0 text-muted-foreground/60 transition-colors hover:text-foreground
  s_113: {"height":"0.375rem","width":"100%","overflow":"hidden","borderRadius":"0.5rem","backgroundColor":"hsl(var(--muted))"}, // h-1.5 w-full overflow-hidden rounded-full bg-muted
  s_114: {"height":"100%","borderRadius":"0.5rem","backgroundColor":"hsl(var(--primary))"}, // h-full rounded-full bg-primary transition-all duration-200
  s_117: {"marginBottom":"0.5rem","color":"hsl(var(--muted-foreground))"}, // mb-2 text-[11px] text-muted-foreground
  s_121: {"marginRight":"0.375rem"}, // mr-1.5 size-3
  s_122: {"flexShrink":0,"borderColor":"hsl(var(--border))","padding":"0.75rem"}, // shrink-0 space-y-2 border-t border-border p-3
  s_124: {"display":"flex","gap":"0.5rem"}, // flex gap-2
  s_127: {"display":"flex","flexDirection":"column","overflow":"hidden","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","backgroundColor":"hsl(var(--background))"}, // animate-in slide-in-from-bottom-2 duration-200 ease-out absolute bottom-3 right-3 z-30 flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl
  s_128: {"display":"flex","left":0,"top":0,"alignItems":"center","justifyContent":"center"}, // group absolute left-0 top-0 z-10 flex size-4 cursor-nwse-resize items-center justify-center
  s_129: {"borderRadius":"0.5rem"}, // size-1.5 rounded-full bg-border transition-colors group-hover:bg-muted-foreground/60
  s_130: {"display":"flex","flexShrink":0,"alignItems":"center","justifyContent":"space-between","borderColor":"hsl(var(--border))","paddingLeft":"1.25rem","paddingRight":"0.5rem"}, // flex h-8 shrink-0 items-center justify-between border-b border-border pl-5 pr-2
  s_131: {"overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","fontSize":"0.75rem","fontWeight":500}, // truncate text-xs font-medium
  s_132: {"height":"1.5rem","width":"1.5rem","flexShrink":0}, // h-6 w-6 shrink-0
  s_134: {"backgroundColor":"#000"}, // bg-black
  s_135: {"height":"100%","width":"100%"}, // h-full w-full object-contain
  s_136: {"padding":"1.5rem"}, // p-6
  s_137: {"fontSize":"1.125rem","fontWeight":600,"marginBottom":"0.5rem"}, // text-lg font-semibold mb-2
  s_138: {"fontSize":"0.875rem","color":"hsl(var(--muted-foreground))","marginBottom":"1rem"}, // text-sm text-muted-foreground mb-4
  s_139: {"fontSize":"0.875rem","paddingInline":"1rem","paddingBlock":"0.5rem","borderRadius":"0.375rem","backgroundColor":"hsl(var(--primary))"}, // text-sm px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90
  s_140: {"borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","padding":"0.75rem"}, // rounded-md border border-destructive/40 bg-destructive/5 p-3
  s_141: {"display":"flex","width":"100%","alignItems":"center","gap":"0.5rem","textAlign":"left"}, // flex w-full items-center gap-2 text-left
  s_142: {"marginTop":"0.125rem","flexShrink":0,"color":"hsl(var(--destructive))"}, // mt-0.5 size-4 shrink-0 text-destructive
  s_143: {"flex":"1 1 0%","fontSize":"0.75rem","fontWeight":600,"textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--destructive))"}, // flex-1 text-xs font-semibold uppercase tracking-wide text-destructive
  s_145: {"marginBottom":"0.5rem","lineHeight":1.625,"color":"hsl(var(--muted-foreground))"}, // mb-2 text-[11px] leading-relaxed text-muted-foreground
  s_147: {"marginBottom":"0.375rem","color":"hsl(var(--muted-foreground))"}, // mb-1.5 text-[11px] text-muted-foreground
  s_148: {"marginBottom":"0.5rem","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.5rem","paddingBlock":"0.25rem","fontFamily":"ui-monospace, monospace","color":"hsl(var(--foreground))"}, // mb-2 break-all rounded border border-border bg-muted/40 px-2 py-1 font-mono text-[10px] text-foreground
  s_150: {"marginBottom":"0.5rem","fontFamily":"ui-monospace, monospace","fontSize":"0.75rem"}, // mb-2 h-8 font-mono text-xs
  s_151: {"marginBottom":"0.5rem","color":"hsl(var(--destructive))"}, // mb-2 text-[11px] text-destructive
  s_153: {"display":"block","flex":"1 1 0%"}, // relative flex-1 max-w-md
  s_154: {"display":"block","color":"hsl(var(--muted-foreground))"}, // pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground
  s_155: {"fontSize":"0.875rem"}, // h-9 pl-9 text-sm
  s_156: {"display":"block","color":"hsl(var(--muted-foreground))"}, // absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground
  s_158: {"fontSize":"0.75rem","color":"hsl(var(--muted-foreground))","flexShrink":0}, // text-xs text-muted-foreground shrink-0
  s_159: {"display":"initial"}, // ml-auto
  s_160: {"gap":"0.375rem","fontSize":"0.75rem"}, // h-9 gap-1.5 text-xs
  s_162: {"display":"flex","alignItems":"center","borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","padding":"0.125rem"}, // flex items-center rounded-md border border-border bg-muted/30 p-0.5
  s_167: {"display":"flex","alignItems":"center","gap":"0.375rem"}, // flex items-center gap-1.5
  s_168: {"display":"flex","height":"100%","minHeight":0}, // flex h-full min-h-0
  s_169: {"flexShrink":0,"borderColor":"hsl(var(--border))","overflowY":"auto"}, // w-80 shrink-0 border-r border-border overflow-y-auto
  s_170: {"paddingInline":"1rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))","textAlign":"center"}, // px-4 py-8 text-xs text-muted-foreground text-center
  s_171: {"fontSize":"0.875rem","fontWeight":500,"overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap"}, // text-sm font-medium truncate
  s_172: {"fontSize":"0.75rem","color":"hsl(var(--muted-foreground))","overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","marginTop":"0.125rem"}, // text-xs text-muted-foreground truncate mt-0.5
  s_174: {"marginTop":"0.375rem"}, // mt-1.5
  s_175: {"display":"flex","gap":"0.25rem","marginTop":"0.375rem"}, // flex flex-wrap gap-1 mt-1.5
  s_176: {"display":"inline-flex","alignItems":"center","borderRadius":"0.5rem","paddingInline":"0.5rem","paddingBlock":"0.125rem","fontWeight":500,"color":"hsl(var(--primary))","borderWidth":"1px","borderStyle":"solid"}, // inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[9px] font-medium text-primary border border-primary/20
  s_177: {"display":"inline-flex","alignItems":"center","borderRadius":"0.5rem","paddingInline":"0.5rem","paddingBlock":"0.125rem","color":"hsl(var(--muted-foreground))"}, // inline-flex items-center rounded-full bg-muted/50 px-2 py-0.5 text-[9px] text-muted-foreground
  s_181: {"borderRadius":"0.5rem"}, // size-6 animate-pulse rounded-full bg-muted/50
  s_182: {"display":"initial"}, // object-cover transition-transform duration-300 group-hover:scale-105
  s_183: {"height":"100%","width":"100%"}, // h-full w-full object-cover transition-transform duration-300 group-hover:scale-105
  s_184: {"display":"flex","flexDirection":"column","overflow":"hidden","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","backgroundColor":"hsl(var(--card))"}, // group flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20 hover:border-border/80
  s_185: {"display":"block","width":"100%","overflow":"hidden"}, // relative aspect-video w-full overflow-hidden bg-muted/30
  s_186: {"display":"flex","height":"100%","width":"100%","alignItems":"center","justifyContent":"center"}, // flex h-full w-full items-center justify-center text-muted-foreground/30
  s_187: {"display":"flex","flex":"1 1 0%","flexDirection":"column","gap":"0.625rem"}, // flex flex-1 flex-col gap-2.5 p-3.5
  s_188: {"fontSize":"0.875rem","fontWeight":600,"lineHeight":1.375,"overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap"}, // text-sm font-semibold leading-snug truncate group-hover:text-primary transition-colors
  s_189: {"marginTop":"0.125rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))","overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap"}, // mt-0.5 text-xs text-muted-foreground truncate
  s_191: {"display":"inline-flex","alignItems":"center","borderRadius":"0.5rem","paddingInline":"0.5rem","paddingBlock":"0.125rem","fontWeight":500,"color":"hsl(var(--primary))","borderWidth":"1px","borderStyle":"solid"}, // inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary border border-primary/20
  s_193: {"paddingTop":"0.25rem"}, // mt-auto pt-1
  s_194: {"display":"inline-flex","alignItems":"center","gap":"0.25rem","fontSize":"0.75rem","fontWeight":500,"color":"hsl(var(--primary))","opacity":0}, // inline-flex items-center gap-1 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100
  s_196: {"display":"grid","gap":"1rem","padding":"1rem"}, // grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3
  s_197: {"display":"block","inset":0}, // fixed inset-0 z-40 bg-black/65 backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0
  s_198: {"display":"block","overflow":"hidden","borderWidth":"1px","borderStyle":"solid","backgroundColor":"hsl(var(--background))"}, // fixed inset-x-3 bottom-3 top-[4.25rem] z-50 overflow-hidden border border-white/15 bg-background shadow-2xl outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:inset-x-5 sm:bottom-5 lg:inset-x-8 lg:bottom-8
  s_206: {"flex":"1 1 0%","minHeight":0,"overflow":"hidden"}, // flex-1 min-h-0 overflow-hidden
  s_207: {"height":"100%","overflowY":"auto"}, // h-full overflow-y-auto
  s_208: {"display":"flex","flexDirection":"column","alignItems":"center","justifyContent":"center","textAlign":"center"}, // flex flex-col items-center justify-center py-16 text-center
  s_209: {"fontSize":"0.875rem","color":"hsl(var(--muted-foreground))"}, // text-sm text-muted-foreground
  s_210: {"marginTop":"0.5rem","fontSize":"0.75rem","color":"hsl(var(--primary))"}, // mt-2 text-xs text-primary hover:text-primary/80
  s_211: {"display":"grid","inset":0}, // fixed inset-0 z-40 grid place-items-center bg-black/65 backdrop-blur-sm
  s_212: {"display":"flex","alignItems":"center","gap":"0.5rem","paddingInline":"1rem","paddingBlock":"0.75rem","fontSize":"0.875rem","color":"#fff"}, // flex items-center gap-2 bg-black/75 px-4 py-3 text-sm text-white
  s_213: {"display":"initial"}, // size-4 animate-spin text-[#E8E044]
  s_214: {"display":"block","inset":0}, // absolute inset-0 isolate
  s_216: {"display":"grid","borderWidth":"1px","borderStyle":"solid"}, // grid size-10 place-items-center border border-white/20 bg-black/25 text-white/85 backdrop-blur-md transition-colors hover:border-white/45 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] disabled:pointer-events-none disabled:opacity-30
  s_219: {"marginRight":"0.375rem"}, // mr-1.5 size-4
  s_220: {"height":"100%"}, // h-full
  s_221: {"display":"block","height":"100%","overflow":"hidden","color":"#fff"}, // relative h-full min-h-[32rem] overflow-hidden bg-[#07100d] text-white
  s_223: {"display":"block","inset":0}, // absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(232,224,68,0.08),transparent_60%)]
  s_224: {"display":"block"}, // pointer-events-none absolute inset-x-0 bottom-0 z-10 h-1/2 bg-gradient-to-t from-black/45 via-black/10 to-transparent
  s_225: {"display":"block","top":0}, // pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-gradient-to-b from-black/25 to-transparent
  s_226: {"display":"flex","alignItems":"center","gap":"0.5rem"}, // absolute right-5 top-5 z-30 flex items-center gap-2 sm:right-8 sm:top-8
  s_230: {"fontFamily":"ui-monospace, monospace"}, // font-mono text-[9px] text-current/65
  s_231: {"display":"inline-flex","alignItems":"center","gap":"0.5rem","borderWidth":"1px","borderStyle":"solid","fontSize":"0.75rem","fontWeight":600,"color":"#fff"}, // inline-flex h-10 items-center gap-2 border border-white/20 bg-black/45 px-3.5 text-xs font-semibold text-white backdrop-blur-md transition-colors hover:border-[#E8E044]/70 hover:bg-black/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] disabled:cursor-not-allowed disabled:opacity-40
  s_232: {"display":"initial"}, // size-4 text-[#E8E044]
  s_233: {"display":"block","left":0,"height":"88%","width":"92%"}, // pointer-events-none absolute bottom-0 left-0 z-10 h-[88%] w-[92%] bg-[radial-gradient(ellipse_at_bottom_left,rgba(2,8,6,0.76)_0%,rgba(2,8,6,0.58)_30%,rgba(2,8,6,0.2)_55%,transparent_76%)] backdrop-blur-[14px] sm:w-[78%] lg:w-[68%]
  s_234: {"display":"block"}, // absolute inset-x-0 bottom-0 z-20
  s_235: {"width":"100%","paddingInline":"1.25rem","paddingBottom":"1.25rem"}, // mx-auto w-full max-w-[1440px] px-5 pb-5 sm:px-8 sm:pb-8 lg:px-14 lg:pb-10
  s_236: {"display":"initial"}, // max-w-2xl
  s_237: {"display":"flex","alignItems":"center","gap":"0.5rem","fontWeight":600,"textTransform":"uppercase","letterSpacing":"0.1em"}, // flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#E8E044] sm:text-[11px]
  s_239: {"marginTop":"0.75rem","fontWeight":600,"letterSpacing":"0.1em","color":"#fff"}, // mt-3 max-w-3xl text-balance text-[clamp(2.25rem,4.2vw,4.5rem)] font-semibold leading-[0.96] tracking-[-0.045em] text-white
  s_240: {"marginTop":"0.75rem","display":"flex","alignItems":"center","gap":"0.375rem","fontSize":"0.875rem"}, // mt-3 flex items-center gap-1.5 text-sm text-white/[0.72] sm:text-base
  s_241: {"display":"initial"}, // size-3.5 text-[#E8E044]
  s_242: {"marginTop":"0.5rem","fontSize":"0.875rem"}, // mt-2 line-clamp-2 max-w-xl text-sm leading-6 text-white/[0.62]
  s_243: {"marginTop":"0.75rem","display":"flex","alignItems":"center"}, // mt-3 flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-white/50 sm:text-xs
  s_245: {"display":"inline-flex","alignItems":"center","gap":"0.25rem"}, // pointer-events-auto inline-flex items-center gap-1 text-white/[0.58] transition-colors hover:text-white
  s_247: {"marginTop":"1rem"}, // mt-4
  s_248: {"marginTop":"1.25rem","display":"flex","alignItems":"center","justifyContent":"space-between","gap":"1rem","paddingTop":"1rem"}, // mt-5 flex items-center justify-between gap-4 border-t border-white/20 pt-4 sm:mt-7 sm:pt-5
  s_250: {"display":"grid","borderWidth":"1px","borderStyle":"solid"}, // grid size-10 place-items-center border border-white/20 bg-black/25 text-white/85 backdrop-blur-md transition-colors hover:border-[#E8E044]/70 hover:bg-[#E8E044]/10 hover:text-[#E8E044] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  s_251: {"display":"initial"}, // size-[18px]
  s_252: {"marginLeft":"0.5rem","fontFamily":"ui-monospace, monospace","letterSpacing":"0.1em"}, // ml-2 font-mono text-[11px] tracking-[0.16em] text-white/50
  s_253: {"borderRadius":"0.5rem","paddingInline":"1rem","fontSize":"0.875rem","fontWeight":600,"color":"#000"}, // h-11 rounded-none bg-[#E8E044] px-4 text-sm font-semibold text-black shadow-xl hover:bg-[#f0e84e] sm:px-5
  s_254: {"display":"initial"}, // size-4 animate-spin
  s_256: {"marginBottom":"0.375rem","display":"block","fontSize":"0.875rem","fontWeight":500,"color":"hsl(var(--foreground))"}, // mb-1.5 block text-sm font-medium text-foreground
  s_257: {"marginLeft":"0.125rem","color":"hsl(var(--destructive))"}, // ml-0.5 text-destructive
  s_258: {"borderColor":"hsl(var(--border))","paddingTop":"1.25rem"}, // border-t border-border pt-5
  s_259: {"marginBottom":"0.25rem","fontSize":"0.875rem","fontWeight":600,"color":"hsl(var(--foreground))"}, // mb-1 text-sm font-semibold text-foreground
  s_260: {"marginBottom":"0.75rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // mb-3 text-xs text-muted-foreground
  s_263: {"marginTop":"0.5rem"}, // mt-2 space-y-1
  s_264: {"display":"flex","alignItems":"center","gap":"0.5rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // flex items-center gap-2 text-xs text-muted-foreground
  s_266: {"flexShrink":0,"fontFamily":"ui-monospace, monospace"}, // shrink-0 font-mono text-[10px]
  s_267: {"marginBottom":"0.75rem","display":"flex","alignItems":"center","gap":"0.75rem"}, // mb-3 flex items-center gap-3
  s_270: {"marginBottom":"0.75rem","display":"flex","gap":"0.375rem"}, // mb-3 flex flex-wrap gap-1.5
  s_271: {"borderRadius":"0.5rem","paddingInline":"0.25rem","fontWeight":600,"textTransform":"uppercase"}, // rounded bg-blue-800/50 px-1 py-px text-[9px] font-semibold uppercase leading-none text-blue-300
  s_273: {"display":"block","marginBottom":"0.75rem"}, // relative mb-3
  s_275: {"display":"block","left":0,"borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","backgroundColor":"hsl(var(--background))"}, // absolute left-0 top-8 z-20 w-80 rounded-md border border-border bg-background shadow-lg
  s_276: {"padding":"0.5rem"}, // p-2
  s_278: {"overflowY":"auto"}, // max-h-48 overflow-y-auto
  s_279: {"paddingInline":"0.75rem","paddingBlock":"0.5rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // px-3 py-2 text-xs text-muted-foreground
  s_280: {"display":"flex","width":"100%","alignItems":"flex-start","gap":"0.5rem","paddingInline":"0.75rem","paddingBlock":"0.375rem","textAlign":"left","fontSize":"0.75rem"}, // flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/50
  s_281: {"flexShrink":0,"fontFamily":"ui-monospace, monospace","fontWeight":500,"color":"hsl(var(--foreground))"}, // shrink-0 font-mono font-medium text-foreground
  s_284: {"marginTop":"0.5rem"}, // mt-2 max-w-lg space-y-1.5
  s_285: {"width":"100%","borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","backgroundColor":"hsl(var(--background))","paddingInline":"0.625rem","paddingBlock":"0.375rem","fontFamily":"ui-monospace, monospace","fontSize":"0.75rem","color":"hsl(var(--foreground))"}, // w-full resize-none rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring
  s_288: {"fontSize":"0.75rem"}, // h-7 text-xs
  s_289: {"display":"block","inset":0,"backgroundColor":"hsl(var(--muted))"}, // absolute inset-0 animate-pulse bg-muted
  s_291: {"display":"grid","gap":"0.5rem"}, // grid grid-cols-3 gap-2
  s_296: {"marginBottom":"0.25rem","display":"block","color":"hsl(var(--muted-foreground))"}, // mb-1 block text-[11px] text-muted-foreground
  s_297: {"fontSize":"0.75rem"}, // h-8 text-xs
  s_298: {"display":"flex","height":"100%","width":"100%","minHeight":0,"flexDirection":"column"}, // flex h-full w-full min-h-0 flex-col
  s_299: {"display":"flex","flexShrink":0,"borderColor":"hsl(var(--border))"}, // flex min-h-[400px] shrink-0 border-b border-border
  s_300: {"flex":"1 1 0%","minWidth":0,"overflowY":"auto","borderColor":"hsl(var(--border))","paddingInline":"1.5rem","paddingBlock":"1.25rem"}, // flex-1 min-w-0 overflow-y-auto border-r border-border px-6 py-5 space-y-4
  s_301: {"borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","paddingInline":"0.75rem","paddingBlock":"0.5rem","fontSize":"0.875rem","color":"hsl(var(--destructive))"}, // rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive
  s_327: {"marginBottom":"0.5rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // mb-2 text-xs text-muted-foreground
  s_329: {"display":"flex","alignItems":"center","gap":"0.75rem"}, // flex items-center gap-3
  s_331: {"overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // truncate text-xs text-muted-foreground
  s_333: {"marginTop":"0.5rem","borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.75rem","paddingBlock":"0.5rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // mt-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground
  s_334: {"display":"grid"}, // grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5
  s_339: {"width":"100%","borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","backgroundColor":"hsl(var(--background))","paddingInline":"0.75rem","paddingBlock":"0.5rem","fontSize":"0.875rem","color":"hsl(var(--foreground))","boxShadow":"0 1px 2px 0 rgb(0 0 0 / 0.05)"}, // w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring
  s_342: {"display":"block","height":"400px","width":"400px","flexShrink":0}, // relative h-[400px] w-[400px] shrink-0 self-start
  s_343: {"display":"flex","alignItems":"center","gap":"0.25rem","borderRadius":"0.5rem","paddingInline":"0.5rem","paddingBlock":"0.25rem"}, // absolute bottom-2 right-2 z-10 flex items-center gap-1 rounded bg-black/70 px-2 py-1 text-[10px] text-emerald-400
  s_345: {"display":"flex","height":"100%","flexDirection":"column","alignItems":"center","justifyContent":"center","gap":"0.75rem","color":"hsl(var(--muted-foreground))"}, // flex h-full flex-col items-center justify-center gap-3 text-muted-foreground
  s_346: {"display":"initial"}, // size-8 opacity-30
  s_347: {"fontSize":"0.875rem"}, // text-sm
  s_348: {"padding":"1.5rem"}, // p-6 space-y-6
  s_349: {"display":"flex","alignItems":"center","gap":"0.75rem","borderColor":"hsl(var(--border))","paddingTop":"1rem"}, // flex items-center gap-3 border-t border-border pt-4
  s_350: {"flexShrink":0,"borderColor":"hsl(var(--border))","paddingInline":"1.5rem","paddingBlock":"0.75rem"}, // shrink-0 border-t border-border px-6 py-3
  s_351: {"display":"flex","alignItems":"center","gap":"0.375rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground
  s_352: {"marginTop":"0.5rem","borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","padding":"0.75rem","lineHeight":1.625,"color":"hsl(var(--muted-foreground))"}, // mt-2 max-h-96 overflow-auto rounded-md border border-border bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground
  s_353: {"display":"flex","height":"100%","flexDirection":"column"}, // flex h-full flex-col
  s_354: {"display":"flex","flexShrink":0,"alignItems":"center","borderColor":"hsl(var(--border))","paddingInline":"1.5rem"}, // flex h-11 shrink-0 items-center border-b border-border px-6
  s_355: {"fontSize":"0.875rem","fontWeight":600}, // text-sm font-semibold
  s_356: {"display":"flex","minHeight":0,"flex":"1 1 0%"}, // flex min-h-0 flex-1
  s_357: {"display":"inline-flex","alignItems":"center","gap":"0.25rem","color":"hsl(var(--muted-foreground))"}, // inline-flex items-center gap-1 text-[10px] text-muted-foreground
  s_359: {"display":"inline-flex","alignItems":"center","gap":"0.25rem"}, // inline-flex items-center gap-1 text-[10px] text-blue-400
  s_361: {"display":"inline-flex","alignItems":"center","gap":"0.25rem"}, // inline-flex items-center gap-1 text-[10px] text-emerald-400
  s_363: {"display":"inline-flex","alignItems":"center","gap":"0.25rem","color":"hsl(var(--destructive))"}, // inline-flex items-center gap-1 text-[10px] text-destructive
  s_365: {"marginTop":"0.375rem","display":"flex","alignItems":"center","gap":"0.5rem"}, // mt-1.5 flex items-center gap-2
  s_366: {"flexShrink":0,"textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // w-14 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground
  s_367: {"height":"0.25rem","flex":"1 1 0%","cursor":"pointer"}, // h-1 flex-1 cursor-pointer accent-primary
  s_368: {"flexShrink":0,"fontFamily":"ui-monospace, monospace","color":"hsl(var(--muted-foreground))"}, // w-8 shrink-0 text-right font-mono text-[10px] text-muted-foreground
  s_370: {"fontSize":"0.75rem","fontWeight":600,"textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // text-xs font-semibold uppercase tracking-wide text-muted-foreground
  s_371: {"display":"flex","alignItems":"center","gap":"0.375rem","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.5rem","paddingBlock":"0.25rem","fontWeight":500}, // flex items-center gap-1.5 rounded border border-border bg-muted/20 px-2 py-1 text-[11px] font-medium text-foreground/90 transition-colors hover:bg-muted/40
  s_373: {"display":"none"}, // hidden
  s_374: {"marginTop":"0.5rem","display":"flex","alignItems":"flex-start","gap":"0.375rem","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","paddingInline":"0.625rem","paddingBlock":"0.375rem","color":"hsl(var(--destructive))"}, // mt-2 flex items-start gap-1.5 rounded border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive
  s_375: {"flexShrink":0}, // mt-px size-3.5 shrink-0
  s_377: {"borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.625rem","paddingBlock":"0.375rem"}, // rounded border border-border bg-muted/20 px-2.5 py-1.5
  s_379: {"display":"flex","flexShrink":0,"alignItems":"center","justifyContent":"center","borderRadius":"0.5rem"}, // relative flex size-4 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ring-black/20
  s_380: {"display":"initial"}, // size-2.5 text-white/80
  s_383: {"display":"flex","flexShrink":0,"alignItems":"center","justifyContent":"center","borderRadius":"0.5rem","color":"hsl(var(--muted-foreground))"}, // flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive
  s_385: {"marginTop":"0.5rem","display":"flex","gap":"0.375rem"}, // mt-2 flex flex-wrap gap-1.5
  s_388: {"display":"flex","alignItems":"center","justifyContent":"center","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","color":"hsl(var(--muted-foreground))"}, // flex size-5 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted/50 hover:text-foreground
  s_393: {"display":"flex","alignItems":"center","justifyContent":"space-between","gap":"0.5rem","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","padding":"0.5rem"}, // flex items-center justify-between gap-2 rounded border border-border p-2
  s_395: {"display":"block","overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","fontSize":"0.75rem","fontWeight":500}, // block truncate text-xs font-medium hover:underline
  s_416: {"display":"flex","gap":"0.25rem"}, // flex flex-wrap gap-1 justify-end
  s_417: {"display":"inline-flex","alignItems":"center","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.375rem","fontWeight":500}, // inline-flex items-center rounded border border-border px-1.5 py-px text-[10px] font-medium
  s_418: {"marginLeft":"0.25rem","color":"hsl(var(--muted-foreground))"}, // ml-1 text-muted-foreground
  s_421: {"marginLeft":"0.5rem"}, // ml-2
  s_423: {"display":"inline-flex","alignItems":"center","borderRadius":"0.5rem","paddingInline":"0.375rem","fontWeight":500}, // inline-flex items-center rounded-sm bg-green-500/10 px-1.5 py-px text-[10px] font-medium text-green-600 dark:text-green-400
  s_424: {"display":"inline-flex","alignItems":"center","borderRadius":"0.5rem","backgroundColor":"hsl(var(--muted))","paddingInline":"0.375rem","fontWeight":500,"color":"hsl(var(--muted-foreground))"}, // inline-flex items-center rounded-sm bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground
  s_425: {"marginTop":"0.375rem","lineHeight":1.375}, // mt-1.5 text-[10px] leading-snug text-muted-foreground/80
  s_426: {"display":"initial"}, // space-y-4
  s_429: {"display":"flex","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","padding":"0.125rem"}, // flex rounded-lg border border-border bg-muted/30 p-0.5
  s_430: {"lineHeight":1.625,"color":"hsl(var(--muted-foreground))"}, // text-[11px] leading-relaxed text-muted-foreground
  s_431: {"borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","padding":"0.625rem"}, // space-y-2 rounded-md border border-border/70 p-2.5
  s_432: {"display":"flex","width":"100%","alignItems":"center","justifyContent":"center","gap":"0.375rem","borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.5rem","paddingBlock":"0.375rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50
  s_434: {"display":"flex","alignItems":"center","gap":"0.5rem","fontSize":"0.75rem","color":"hsl(var(--foreground))"}, // flex items-center gap-2 text-xs text-foreground
  s_435: {"color":"hsl(var(--muted-foreground))"}, // size-3 text-muted-foreground
  s_436: {"flex":"1 1 0%"}, // flex-1
  s_440: {"display":"flex","alignItems":"center","justifyContent":"center","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","color":"hsl(var(--muted-foreground))"}, // flex size-5 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50
  s_451: {"fontSize":"0.75rem","color":"hsl(var(--destructive))"}, // text-xs text-destructive
  s_455: {"lineHeight":1.375,"color":"hsl(var(--muted-foreground))"}, // text-[10px] leading-snug text-muted-foreground
  s_458: {"marginTop":"0.25rem","overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap"}, // mt-1 truncate text-[10px] text-muted-foreground/70
  s_459: {"marginTop":"0.375rem","display":"flex","alignItems":"center","gap":"0.25rem"}, // mt-1.5 flex flex-wrap items-center gap-1
  s_460: {"borderRadius":"0.5rem","paddingInline":"0.5rem","fontWeight":500,"color":"hsl(var(--muted-foreground))","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))"}, // rounded-full bg-muted/60 px-2 py-px text-[10px] font-medium text-muted-foreground border border-border
  s_461: {"borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.25rem","color":"hsl(var(--muted-foreground))"}, // rounded border border-border bg-muted/40 px-1 py-px text-[10px] text-muted-foreground
  s_462: {"paddingInline":"0.25rem"}, // px-1 text-[10px] text-muted-foreground/60
  s_463: {"marginTop":"0.125rem"}, // mt-0.5 text-[10px] text-muted-foreground/50
  s_465: {"display":"flex","width":"100%","alignItems":"center","gap":"0.375rem","fontSize":"0.75rem","fontWeight":600,"textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground
  s_468: {"display":"flex","alignItems":"center","justifyContent":"space-between","gap":"0.5rem","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.5rem","paddingBlock":"0.375rem"}, // flex items-center justify-between gap-2 rounded border border-border px-2 py-1.5
  s_470: {"display":"block","overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // block truncate text-xs text-muted-foreground
  s_472: {"display":"flex","alignItems":"center","gap":"0.375rem"}, // flex items-center gap-1.5 text-[10px] text-muted-foreground/70
  s_473: {"display":"flex","flexShrink":0,"alignItems":"center","gap":"0.5rem"}, // flex shrink-0 items-center gap-2
  s_478: {"color":"hsl(var(--muted-foreground))"}, // text-muted-foreground transition-colors hover:text-foreground
  s_480: {"display":"flex","flexDirection":"column","alignItems":"center","justifyContent":"center","gap":"0.5rem","textAlign":"center","color":"hsl(var(--muted-foreground))"}, // flex flex-col items-center justify-center gap-2 py-8 text-center text-muted-foreground
  s_481: {"display":"initial"}, // size-8 opacity-50
  s_484: {"display":"flex","alignItems":"center","justifyContent":"space-between"}, // flex items-center justify-between
  s_485: {"fontSize":"0.75rem","fontWeight":600,"color":"hsl(var(--muted-foreground))"}, // text-xs font-semibold text-muted-foreground
  s_486: {"display":"flex","alignItems":"center","justifyContent":"center","borderRadius":"0.5rem","color":"hsl(var(--muted-foreground))"}, // flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground
  s_489: {"display":"flex","width":"100%","alignItems":"center","gap":"0.375rem","paddingInline":"0.625rem","paddingBlock":"0.5rem","fontSize":"0.75rem","fontWeight":500,"color":"hsl(var(--foreground))"}, // flex w-full items-center gap-1.5 px-2.5 py-2 text-xs font-medium text-foreground
  s_490: {"minWidth":0,"overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap"}, // min-w-0 truncate
  s_491: {"borderColor":"hsl(var(--border))","paddingInline":"0.625rem","paddingBlock":"0.5rem"}, // border-t border-border px-2.5 py-2
  s_492: {"marginBottom":"0.5rem","display":"flex","alignItems":"center","justifyContent":"space-between","gap":"0.5rem"}, // mb-2 flex items-center justify-between gap-2
  s_495: {"display":"flex","alignItems":"center","gap":"0.25rem","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.375rem","paddingBlock":"0.125rem","color":"hsl(var(--muted-foreground))"}, // flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground
  s_496: {"display":"initial"}, // size-3 text-green-500
  s_498: {"marginBottom":"0.5rem"}, // mb-2 space-y-1
  s_499: {"fontWeight":600,"textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // text-[11px] font-semibold uppercase tracking-wide text-muted-foreground
  s_509: {"marginLeft":"0.25rem","color":"hsl(var(--muted-foreground))"}, // ml-1 font-normal text-muted-foreground
  s_514: {"marginBottom":"0.5rem"}, // space-y-1 mb-2
  s_517: {"fontWeight":500,"color":"hsl(var(--foreground))"}, // font-medium text-foreground
  s_518: {"display":"flex","gap":"0.5rem","fontSize":"0.75rem"}, // flex items-baseline gap-2 text-xs
  s_520: {"fontFamily":"ui-monospace, monospace"}, // font-mono text-foreground/80 text-[10px] break-all
  s_521: {"paddingTop":"0.25rem"}, // border-b border-border/50 pt-1
  s_522: {"marginBottom":"0.375rem","fontWeight":600,"textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground
  s_523: {"display":"flex","gap":"0.5rem"}, // flex flex-wrap gap-2
  s_530: {"display":"flex","alignItems":"center","gap":"0.375rem","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.5rem","paddingBlock":"0.25rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground
  s_536: {"gap":"0.375rem","fontSize":"0.75rem"}, // gap-1.5 text-xs
  s_539: {"color":"hsl(var(--muted-foreground))"}, // text-[10px] text-muted-foreground
  s_540: {"display":"flex","alignItems":"center","gap":"0.25rem","color":"hsl(var(--destructive))"}, // flex items-center gap-1 text-[10px] text-destructive
  s_542: {"display":"block"}, // pointer-events-none fixed -left-[9999px] -top-[9999px]
  s_545: {"display":"block","width":"100%","overflow":"hidden","borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","textAlign":"left"}, // group block w-full overflow-hidden rounded-md border border-border bg-muted/30 text-left transition-colors hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  s_546: {"display":"block","width":"100%"}, // relative aspect-video w-full bg-muted/30
  s_547: {"height":"100%","width":"100%"}, // h-full w-full object-cover
  s_548: {"display":"flex","inset":0,"alignItems":"center","justifyContent":"center"}, // absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/10
  s_549: {"display":"flex","alignItems":"center","justifyContent":"center","borderRadius":"0.5rem"}, // flex size-11 items-center justify-center rounded-full bg-foreground/80 text-background transition-transform group-hover:scale-110
  s_550: {"display":"initial"}, // size-5 fill-current
  s_551: {"display":"block","overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","paddingInline":"0.5rem","paddingBlock":"0.375rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // block truncate px-2 py-1.5 text-xs text-muted-foreground group-hover:text-foreground
  s_552: {"display":"flex","width":"100%","alignItems":"center","gap":"0.5rem","overflow":"hidden","borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingBlock":"0.375rem","paddingLeft":"0.375rem","paddingRight":"0.5rem"}, // group flex w-full items-center gap-2 overflow-hidden rounded-md border border-border bg-muted/30 py-1.5 pl-1.5 pr-2 transition-colors hover:border-foreground/20 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  s_553: {"display":"flex","flexShrink":0,"alignItems":"center","justifyContent":"center","borderRadius":"0.5rem"}, // flex size-12 shrink-0 items-center justify-center rounded bg-muted/60
  s_554: {"display":"flex","alignItems":"center","justifyContent":"center","borderRadius":"0.5rem"}, // flex size-7 items-center justify-center rounded-full bg-foreground/80 text-background transition-transform group-hover:scale-110
  s_555: {"display":"initial"}, // size-3.5 fill-current
  s_556: {"minWidth":0,"flex":"1 1 0%","overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","textAlign":"left","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // min-w-0 flex-1 truncate text-left text-xs text-muted-foreground group-hover:text-foreground
  s_563: {"borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.625rem","paddingBlock":"0.5rem"}, // rounded border border-border bg-muted/30 px-2.5 py-2
  s_565: {"marginTop":"0.125rem","lineHeight":1.375,"color":"hsl(var(--muted-foreground))"}, // mt-0.5 text-[11px] leading-snug text-muted-foreground
  s_566: {"display":"flex","alignItems":"center","gap":"0.375rem","fontSize":"0.75rem","fontWeight":600,"textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground
  s_575: {"display":"flex","flexShrink":0,"overflow":"hidden","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))"}, // flex shrink-0 overflow-hidden rounded border border-border
  s_592: {"borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.625rem","paddingBlock":"0.625rem"}, // rounded border border-dashed border-border px-2.5 py-2.5
  s_593: {"fontSize":"0.75rem","color":"hsl(var(--muted-foreground))","marginBottom":"0.5rem"}, // text-xs text-muted-foreground mb-2
  s_596: {"marginRight":"0.375rem"}, // mr-1.5 size-3.5
  s_601: {"display":"flex","alignItems":"center","gap":"0.375rem","paddingInline":"0.25rem","textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // flex items-center gap-1.5 px-1 text-[10px] uppercase tracking-wider text-muted-foreground
  s_602: {"fontFamily":"ui-monospace, monospace"}, // font-mono text-muted-foreground/70
  s_603: {"display":"flex","flexShrink":0,"alignItems":"center","justifyContent":"center","borderRadius":"0.5rem"}, // flex size-4 shrink-0 items-center justify-center rounded-full
  s_615: {"flexShrink":0,"color":"hsl(var(--muted-foreground))"}, // size-3.5 shrink-0 animate-spin text-muted-foreground
  s_621: {"display":"flex","alignItems":"center","gap":"0.625rem","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.625rem","paddingBlock":"0.375rem"}, // flex items-center gap-2.5 rounded border border-border bg-muted/20 px-2.5 py-1.5
  s_622: {"flexShrink":0}, // shrink-0
  s_623: {"minWidth":0,"flex":"1 1 0%","overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","fontSize":"0.75rem","fontWeight":500}, // min-w-0 flex-1 truncate text-xs font-medium text-foreground/90
  s_624: {"flexShrink":0,"fontFamily":"ui-monospace, monospace","color":"hsl(var(--muted-foreground))"}, // shrink-0 font-mono text-[11px] text-muted-foreground
  s_625: {"marginLeft":"1rem"}, // ml-4 space-y-1.5
  s_626: {"paddingInline":"0.25rem","textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // px-1 text-[10px] uppercase tracking-wider text-muted-foreground
  s_627: {"marginLeft":"0.25rem","fontFamily":"ui-monospace, monospace"}, // ml-1 font-mono text-muted-foreground/70
  s_628: {"display":"flex","alignItems":"center","gap":"0.625rem","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.625rem","paddingBlock":"0.25rem"}, // flex items-center gap-2.5 rounded border border-border bg-muted/20 px-2.5 py-1
  s_629: {"flexShrink":0,"borderRadius":"0.5rem"}, // size-2 shrink-0 rounded-full
  s_630: {"minWidth":0,"flex":"1 1 0%","overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","fontSize":"0.75rem"}, // min-w-0 flex-1 truncate text-xs text-foreground/90
  s_631: {"display":"flex","alignItems":"center","gap":"0.375rem","paddingInline":"0.25rem"}, // flex items-center gap-1.5 px-1
  s_632: {"textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // text-[10px] uppercase tracking-wider text-muted-foreground
  s_633: {"paddingInline":"0.25rem","color":"hsl(var(--muted-foreground))"}, // px-1 text-[10px] text-muted-foreground
  s_634: {"display":"flex","width":"100%","alignItems":"center","gap":"0.375rem","paddingBottom":"0.375rem"}, // flex w-full items-center gap-1.5 pb-1.5 group
  s_635: {"color":"hsl(var(--muted-foreground))","flexShrink":0}, // size-3 text-muted-foreground shrink-0
  s_636: {"fontSize":"0.75rem","fontWeight":600}, // text-xs font-semibold
  s_637: {"display":"initial"}, // space-y-0.5 ml-[18px]
  s_641: {"paddingTop":"0.25rem"}, // space-y-3 pt-1
  s_642: {"display":"flex","alignItems":"center"}, // flex items-center justify-end
  s_643: {"display":"flex","alignItems":"center","gap":"0.25rem","color":"hsl(var(--muted-foreground))"}, // flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors
  s_645: {"marginTop":"0.5rem","marginBottom":"0.25rem"}, // mt-2 mb-1
  s_646: {"fontWeight":500,"textTransform":"uppercase","letterSpacing":"0.1em","marginBottom":"0.375rem"}, // text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-1.5
  s_648: {"display":"flex","justifyContent":"space-between","gap":"0.5rem","paddingBlock":"0.125rem"}, // flex items-baseline justify-between gap-2 py-0.5
  s_650: {"fontSize":"0.75rem","fontWeight":500}, // text-xs font-medium tabular-nums text-right
  s_651: {"paddingBlock":"0.25rem"}, // space-y-2 py-1
  s_652: {"paddingBlock":"0.25rem"}, // py-1 space-y-1.5
  s_655: {"display":"flex","alignItems":"center","gap":"0.375rem","marginBottom":"0.125rem"}, // flex items-center gap-1.5 mb-0.5
  s_657: {"color":"hsl(var(--muted-foreground))","lineHeight":1.625,"marginLeft":"0.125rem"}, // text-[11px] text-muted-foreground leading-relaxed ml-0.5
  s_663: {"marginTop":"0.5rem"}, // mt-2 space-y-3
  s_664: {"fontSize":"0.75rem","color":"hsl(var(--muted-foreground))","lineHeight":1.625}, // text-xs text-muted-foreground leading-relaxed
  s_665: {"display":"initial"}, // text-foreground/80
  s_667: {"fontSize":"0.75rem"}, // text-xs text-foreground/90
  s_692: {"flexShrink":0}, // text-muted-foreground/70 shrink-0
  s_693: {"fontFamily":"ui-monospace, monospace","lineHeight":1.375}, // break-all font-mono text-[10px] leading-snug text-foreground/85
  s_697: {"fontFamily":"ui-monospace, monospace"}, // break-all font-mono text-foreground/90
  s_698: {"display":"initial"}, // text-[10px] text-muted-foreground/60
  s_699: {"marginBottom":"0.25rem","fontWeight":600,"textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground
  s_700: {"display":"grid","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-muted-foreground
  s_705: {"display":"initial"}, // text-muted-foreground/70
  s_706: {"fontFamily":"ui-monospace, monospace"}, // font-mono text-foreground/90
  s_707: {"paddingTop":"0.25rem"}, // pt-1
  s_708: {"width":"100%"}, // w-full
  s_709: {"marginRight":"0.375rem"}, // mr-1.5 size-3.5 animate-spin
  s_710: {"marginTop":"0.375rem","fontSize":"0.75rem","color":"hsl(var(--destructive))"}, // mt-1.5 text-xs text-destructive
  s_713: {"flexShrink":0}, // shrink-0 text-muted-foreground/60 transition-colors hover:text-muted-foreground
  s_714: {"display":"initial"}, // size-3 text-green-400
  s_716: {"marginTop":"0.5rem"}, // mt-2
  s_717: {"marginTop":"0.5rem","fontSize":"0.75rem","lineHeight":1.625,"color":"hsl(var(--muted-foreground))"}, // mt-2 text-xs leading-relaxed text-muted-foreground
  s_718: {"display":"flex","minWidth":0,"alignItems":"center","gap":"0.5rem"}, // flex min-w-0 items-center gap-2
  s_719: {"display":"flex","flexShrink":0,"alignItems":"center","gap":"0.375rem","borderRadius":"0.375rem","paddingInline":"0.5rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // flex h-10 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  s_721: {"display":"none"}, // hidden lg:inline
  s_722: {"display":"initial"}, // lg:hidden
  s_723: {"display":"none","height":"1.25rem","flexShrink":0}, // hidden h-5 w-px shrink-0 bg-border md:block
  s_724: {"gap":"0.375rem","borderRadius":"0.375rem"}, // gap-1.5 rounded-md
  s_726: {"marginLeft":"0.5rem","flexShrink":0,"borderRadius":"0.375rem"}, // ml-2 size-10 shrink-0 rounded-md text-foreground/70 transition-colors hover:bg-foreground/[0.08] hover:text-foreground
  s_728: {"display":"initial"}, // w-48
  s_731: {"fontSize":"0.75rem"}, // max-w-xs text-xs
  s_732: {"marginRight":"0.5rem"}, // mr-2 size-3.5
  s_733: {"flexShrink":0,"borderColor":"hsl(var(--border))","backgroundColor":"hsl(var(--background))","display":"flex","alignItems":"center","paddingInline":"0.375rem"}, // shrink-0 border-l border-border bg-background hover:bg-muted transition-colors flex items-center px-1.5
  s_734: {"display":"flex","alignItems":"center","gap":"0.375rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))","paddingBlock":"0.75rem"}, // flex items-center gap-1.5 [writing-mode:vertical-lr] rotate-180 text-xs text-muted-foreground hover:text-foreground py-3
  s_735: {"display":"initial"}, // size-3.5 rotate-90
  s_736: {"display":"flex","width":"24rem","flexShrink":0,"minHeight":0,"overflow":"hidden","flexDirection":"column"}, // relative w-[24rem] shrink-0 min-h-0 overflow-hidden flex flex-col
  s_737: {"display":"flex","left":0,"width":"1rem","alignItems":"center","justifyContent":"center"}, // absolute inset-y-0 left-0 z-20 w-4 -translate-x-1/2 transition-all ease-linear after:absolute after:inset-y-0 after:left-1/2 after:-translate-x-1/2 after:w-[2px] after:rounded-full after:transition-all hover:after:w-1 hover:after:bg-primary/40 cursor-e-resize flex items-center justify-center group/rail
  s_738: {"color":"hsl(var(--muted-foreground))","opacity":0}, // size-3 text-muted-foreground opacity-0 group-hover/rail:opacity-100 transition-opacity
  s_739: {"width":"100%","borderColor":"hsl(var(--border))","backgroundColor":"hsl(var(--background))","display":"flex","flexDirection":"column","minHeight":0}, // w-full border-l border-border bg-background flex flex-col min-h-0
  s_740: {"flex":"1 1 0%","display":"flex","flexDirection":"column","minHeight":0}, // flex-1 flex flex-col min-h-0
  s_741: {"display":"grid","flexShrink":0,"width":"100%","borderRadius":"0.5rem","borderColor":"hsl(var(--border))","padding":"0"}, // grid grid-cols-4 shrink-0 w-full rounded-none border-b border-border h-10 bg-transparent p-0
  s_742: {"gap":"0.25rem","borderRadius":"0.5rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))","minWidth":0,"paddingInline":"0.25rem"}, // gap-1 rounded-none border-b-2 border-transparent text-xs text-muted-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none min-w-0 px-1
  s_748: {"flex":"1 1 0%","overflowY":"auto","padding":"0.75rem","marginTop":"0"}, // flex-1 overflow-y-auto p-3 mt-0 data-[state=inactive]:hidden
  s_749: {"display":"flex","alignItems":"center","gap":"0.375rem","borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.75rem","fontSize":"0.875rem","fontWeight":500}, // flex h-10 w-44 items-center gap-1.5 rounded-md border border-border bg-muted/30 px-3 text-sm font-medium transition-colors hover:bg-muted/50 sm:w-[280px]
  s_750: {"flex":"1 1 0%","overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","textAlign":"left"}, // flex-1 truncate text-left
  s_751: {"flexShrink":0,"color":"hsl(var(--muted-foreground))"}, // size-3.5 shrink-0 text-muted-foreground ml-auto
  s_752: {"width":"280px","padding":"0"}, // w-[280px] p-0
  s_753: {"borderColor":"hsl(var(--border))","padding":"0.5rem"}, // border-b border-border p-2
  s_755: {"display":"block","color":"hsl(var(--muted-foreground))"}, // pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground
  s_756: {"fontSize":"0.75rem"}, // h-8 pl-8 text-xs
  s_757: {"overflowY":"auto","paddingBlock":"0.25rem"}, // max-h-64 overflow-y-auto py-1
  s_758: {"paddingInline":"0.75rem","paddingBlock":"1rem","textAlign":"center","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // px-3 py-4 text-center text-xs text-muted-foreground
  s_759: {"flexShrink":0,"color":"hsl(var(--primary))"}, // size-3.5 shrink-0 text-primary
  s_760: {"flexShrink":0}, // size-3.5 shrink-0
  s_761: {"minWidth":0,"flex":"1 1 0%"}, // min-w-0 flex-1
  s_762: {"color":"hsl(var(--muted-foreground))","overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap"}, // text-[10px] text-muted-foreground truncate
  s_765: {"color":"hsl(var(--muted-foreground))"}, // size-8 animate-pulse text-muted-foreground
  s_766: {"display":"flex","height":"100%","width":"100%","alignItems":"center","justifyContent":"center"}, // flex h-full w-full items-center justify-center bg-background/50
  s_767: {"color":"hsl(var(--muted-foreground))"}, // size-6 animate-spin text-muted-foreground
  s_768: {"display":"flex","height":"100%","width":"100%","flexDirection":"column","alignItems":"center","justifyContent":"center","gap":"1rem"}, // flex h-full w-full flex-col items-center justify-center gap-4 bg-background/50
  s_769: {"display":"flex","alignItems":"center","justifyContent":"center","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))"}, // flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-muted/50
  s_770: {"color":"hsl(var(--muted-foreground))"}, // size-8 text-muted-foreground
  s_771: {"textAlign":"center"}, // text-center
  s_773: {"marginTop":"0.25rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // mt-1 max-w-xs text-xs text-muted-foreground
  s_774: {"display":"flex","height":"100%","width":"100%","flexDirection":"column","alignItems":"center","justifyContent":"center","gap":"0.75rem"}, // flex h-full w-full flex-col items-center justify-center gap-3 bg-background/50
  s_775: {"color":"hsl(var(--destructive))"}, // size-7 text-destructive
  s_776: {"textAlign":"center","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // max-w-md text-center text-xs text-muted-foreground
  s_778: {"height":"100%","width":"100%"}, // h-full w-full
  s_779: {"height":"100%","overflow":"hidden"}, // h-full overflow-hidden
  s_780: {"display":"flex","height":"100%","flexDirection":"column"}, // relative flex h-full flex-col
  s_781: {"display":"flex","height":"3rem","flexShrink":0,"alignItems":"center","justifyContent":"space-between","borderColor":"hsl(var(--border))","backgroundColor":"hsl(var(--background))","paddingInline":"0.75rem"}, // flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-3
  s_783: {"display":"grid","borderRadius":"0.375rem","color":"hsl(var(--muted-foreground))"}, // grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  s_785: {"display":"flex","alignItems":"center","gap":"0.5rem","paddingInline":"1rem","paddingBlock":"0.5rem","fontSize":"0.875rem"}, // flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-300
  s_786: {"height":"1rem","width":"1rem","flexShrink":0}, // h-4 w-4 shrink-0 animate-spin
  s_787: {"display":"flex","flex":"1 1 0%","minHeight":0}, // relative flex-1 flex min-h-0
  s_788: {"display":"block","width":"30rem","flexShrink":0,"minHeight":0}, // relative w-[30rem] shrink-0 min-h-0
  s_789: {"display":"flex","inset":0,"overflow":"hidden","flexDirection":"column","borderColor":"hsl(var(--border))","backgroundColor":"hsl(var(--background))"}, // absolute inset-0 overflow-hidden flex flex-col border-r border-border bg-background
  s_790: {"display":"flex","alignItems":"center","justifyContent":"center","color":"hsl(var(--muted-foreground))"}, // absolute top-5 -right-4 z-20 flex size-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground
  s_792: {"flex":"1 1 0%","display":"block"}, // flex-1 relative
  s_793: {"display":"flex","alignItems":"center","gap":"0.375rem"}, // absolute top-3 right-3 z-20 flex items-center gap-1.5
  s_794: {"display":"inline-flex","alignItems":"center","justifyContent":"center","borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","boxShadow":"0 1px 2px 0 rgb(0 0 0 / 0.05)","color":"hsl(var(--muted-foreground))"}, // inline-flex size-8 items-center justify-center rounded-md border border-border bg-background/95 backdrop-blur shadow-sm text-muted-foreground hover:text-foreground transition-colors
  s_796: {"display":"flex","borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","padding":"0.125rem","boxShadow":"0 1px 2px 0 rgb(0 0 0 / 0.05)"}, // flex rounded-md border border-border bg-background/95 p-0.5 shadow-sm
  s_797: {"display":"block","width":"30rem"}, // absolute top-3 left-3 z-20 w-[30rem]
  s_798: {"display":"flex","width":"100%","paddingRight":"0.75rem","borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","alignItems":"center","fontSize":"0.875rem"}, // relative w-full h-10 pl-9 pr-3 rounded-md border border-primary/50 bg-background/95 backdrop-blur shadow-[0_0_0_1px_hsl(var(--primary)/0.15),0_4px_12px_-2px_hsl(var(--primary)/0.25)] flex items-center text-sm text-foreground/80 hover:border-primary hover:bg-background hover:text-foreground hover:shadow-[0_0_0_1px_hsl(var(--primary)/0.25),0_6px_16px_-2px_hsl(var(--primary)/0.35)] transition
  s_799: {"display":"block","color":"hsl(var(--primary))"}, // pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-primary
  s_800: {"marginTop":"0.25rem","paddingLeft":"0.25rem","color":"hsl(var(--muted-foreground))"}, // mt-1 pl-1 text-[11px] text-muted-foreground
  s_801: {"display":"block","inset":0}, // absolute inset-0
  s_802: {"display":"flex","flexDirection":"column","gap":"1rem"}, // flex flex-col gap-4
  s_805: {"fontSize":"0.75rem","fontWeight":600,"textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // text-xs font-semibold uppercase tracking-wider text-muted-foreground
  s_806: {"borderRadius":"0.5rem","paddingInline":"0.375rem","paddingBlock":"0.125rem","fontWeight":500,"textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // rounded-sm bg-secondary/40 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground
  s_807: {"display":"flex","gap":"0.375rem"}, // flex flex-wrap gap-1.5
  s_808: {"display":"initial"}, // size-3.5 text-green-400
  s_810: {"display":"initial"}, // space-y-3
  s_811: {"borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","padding":"0.75rem"}, // rounded border border-border p-3
  s_812: {"display":"flex","alignItems":"flex-start","justifyContent":"space-between","gap":"0.75rem"}, // flex items-start justify-between gap-3
  s_814: {"fontSize":"0.75rem","fontWeight":500,"color":"hsl(var(--foreground))"}, // text-xs font-medium text-foreground
  s_815: {"marginTop":"0.25rem","lineHeight":"1rem","color":"hsl(var(--muted-foreground))"}, // mt-1 text-[11px] leading-4 text-muted-foreground
  s_818: {"marginTop":"0.5rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // mt-2 text-xs text-muted-foreground
  s_819: {"marginTop":"0.5rem"}, // mt-2 space-y-1.5
  s_820: {"display":"flex","alignItems":"center","justifyContent":"space-between","gap":"0.75rem","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","padding":"0.5rem"}, // flex items-center justify-between gap-3 rounded border border-border p-2
  s_824: {"flexShrink":0,"borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.625rem","paddingBlock":"0.25rem","fontWeight":500,"color":"hsl(var(--foreground))"}, // shrink-0 rounded border border-border px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60
  s_825: {"padding":"0.75rem","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))"}, // p-3 rounded-lg bg-secondary/50 border border-border hover:bg-secondary/70 transition-colors
  s_826: {"display":"flex","alignItems":"center","gap":"0.5rem","color":"hsl(var(--muted-foreground))","marginBottom":"0.5rem"}, // flex items-center gap-2 text-muted-foreground mb-2
  s_827: {"fontSize":"0.75rem","fontWeight":500}, // text-xs font-medium
  s_828: {"fontSize":"1.125rem","fontWeight":600,"color":"hsl(var(--foreground))","fontFamily":"ui-monospace, monospace"}, // text-lg font-semibold text-foreground font-mono
  s_829: {"fontSize":"0.75rem","lineHeight":1.625}, // text-xs leading-relaxed
  s_831: {"display":"flex","alignItems":"flex-start","justifyContent":"space-between","gap":"0.5rem"}, // flex items-start justify-between gap-2
  s_833: {"fontSize":"0.875rem","fontWeight":600,"lineHeight":1.375}, // text-sm font-semibold leading-snug
  s_834: {"marginTop":"0.125rem","color":"hsl(var(--muted-foreground))"}, // mt-0.5 text-[11px] text-muted-foreground
  s_835: {"marginTop":"0.25rem"}, // mt-1
  s_836: {"marginTop":"0.125rem"}, // mt-0.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors
  s_841: {"display":"grid","gap":"0.625rem"}, // grid grid-cols-3 gap-2.5
  s_847: {"display":"initial"}, // size-4
  s_848: {"display":"flex","alignItems":"center","justifyContent":"space-between","marginBottom":"0.5rem"}, // flex items-center justify-between mb-2
  s_849: {"fontWeight":500,"textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // text-[10px] font-medium uppercase tracking-wider text-muted-foreground
  s_850: {"display":"flex","alignItems":"center","gap":"0.125rem","color":"hsl(var(--primary))"}, // flex items-center gap-0.5 text-[10px] text-primary hover:text-primary/80 transition-colors
  s_852: {"display":"flex","gap":"0.375rem","marginBottom":"0.75rem"}, // flex flex-wrap gap-1.5 mb-3
  s_853: {"display":"inline-flex","alignItems":"center","gap":"0.25rem","borderRadius":"0.5rem","paddingInline":"0.5rem","paddingBlock":"0.125rem","color":"hsl(var(--muted-foreground))"}, // inline-flex items-center gap-1 rounded-full bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground
  s_855: {"display":"inline-flex","alignItems":"center","borderRadius":"0.5rem","paddingInline":"0.5rem","paddingBlock":"0.125rem","color":"hsl(var(--muted-foreground))"}, // inline-flex items-center rounded-full bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground
  s_856: {"display":"inline-flex","alignItems":"center","borderRadius":"0.5rem","paddingInline":"0.5rem","paddingBlock":"0.125rem","borderWidth":"1px","borderStyle":"solid"}, // inline-flex items-center rounded-full bg-emerald-950/40 px-2 py-0.5 text-[10px] text-emerald-400 border border-emerald-700/30
  s_857: {"display":"grid","gap":"0.5rem"}, // grid grid-cols-2 gap-2
  s_858: {"minWidth":0,"borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.75rem","paddingBlock":"0.625rem","textAlign":"left"}, // min-w-0 rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-left transition-colors hover:bg-muted/40
  s_861: {"overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","fontSize":"0.75rem","fontWeight":500,"color":"hsl(var(--foreground))"}, // truncate text-xs font-medium text-foreground
  s_862: {"marginTop":"0.125rem"}, // mt-0.5 text-[10px] text-muted-foreground/70
  s_863: {"fontSize":"0.75rem","lineHeight":1.625}, // max-w-xs space-y-1 text-xs leading-relaxed
  s_865: {"fontWeight":600}, // font-semibold
  s_867: {"marginTop":"0.5rem","display":"flex","alignItems":"center","gap":"0.125rem","color":"hsl(var(--primary))"}, // mt-2 flex items-center gap-0.5 text-[10px] text-primary hover:text-primary/80 transition-colors
  s_868: {"display":"flex","alignItems":"center","gap":"0.25rem","paddingLeft":"0.5rem","paddingTop":"0.125rem","color":"hsl(var(--muted-foreground))"}, // flex flex-wrap items-center gap-1 pl-2 pt-0.5 text-[10px] text-muted-foreground
  s_869: {"fontWeight":500,"textTransform":"uppercase","letterSpacing":"0.1em"}, // font-medium uppercase tracking-wide text-muted-foreground/80
  s_871: {"display":"initial"}, // size-3 text-muted-foreground/60
  s_872: {"display":"initial"}, // size-2.5 text-muted-foreground/60
  s_873: {"flexShrink":0}, // size-2.5 shrink-0
  s_874: {"overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","fontFamily":"ui-monospace, monospace"}, // max-w-[200px] truncate font-mono text-muted-foreground/90
  s_875: {"fontFamily":"ui-monospace, monospace"}, // font-mono text-muted-foreground/80
  s_876: {"flexShrink":0}, // size-2.5 shrink-0 text-muted-foreground/60
  s_877: {"display":"flex","height":"100%","minHeight":0,"flexDirection":"column"}, // flex h-full min-h-0 flex-col
  s_878: {"flexShrink":0,"paddingInline":"1rem","paddingTop":"1rem","paddingBottom":"0.75rem"}, // shrink-0 space-y-4 px-4 pt-4 pb-3
  s_879: {"display":"initial"}, // space-y-1
  s_880: {"fontSize":"0.875rem","fontWeight":600,"color":"hsl(var(--foreground))"}, // text-sm font-semibold text-foreground
  s_881: {"fontSize":"0.75rem","lineHeight":1.625,"color":"hsl(var(--muted-foreground))"}, // text-xs leading-relaxed text-muted-foreground
  s_882: {"minHeight":0,"flex":"1 1 0%","overflowY":"auto","paddingInline":"1rem","paddingBottom":"1rem"}, // min-h-0 flex-1 overflow-y-auto px-4 pb-4
  s_883: {"display":"flex","height":"100%","flexDirection":"column","padding":"1rem"}, // flex h-full flex-col space-y-3 p-4
  s_884: {"display":"initial"}, // space-y-2.5
  s_885: {"borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","padding":"0.5rem"}, // space-y-2 rounded-md border border-dashed border-border/70 bg-secondary/20 p-2 text-[11px]
  s_887: {"fontWeight":600,"color":"hsl(var(--foreground))"}, // font-semibold text-foreground
  s_893: {"paddingInline":"0.375rem","paddingBlock":"0","fontFamily":"ui-monospace, monospace"}, // px-1.5 py-0 font-mono text-[10px]
  s_894: {"display":"flex","alignItems":"center","gap":"0.25rem","paddingInline":"0.25rem"}, // flex flex-wrap items-center gap-1 px-1
  s_897: {"display":"inline-flex","alignItems":"center","overflow":"hidden","borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid"}, // inline-flex items-center overflow-hidden rounded-full border border-primary/40 bg-primary/10 text-[11px] font-normal
  s_898: {"paddingInline":"0.375rem","paddingBlock":"0","color":"hsl(var(--primary))"}, // px-1.5 py-0 text-primary
  s_899: {"paddingInline":"0.375rem","paddingBlock":"0","color":"hsl(var(--foreground))"}, // px-1.5 py-0 text-foreground bg-primary/10
  s_900: {"paddingInline":"0.375rem","paddingBlock":"0","color":"hsl(var(--foreground))"}, // border-transparent bg-secondary/50 px-1.5 py-0 text-[11px] font-normal text-foreground
  s_901: {"paddingInline":"0.375rem","paddingBlock":"0","color":"hsl(var(--muted-foreground))"}, // border-dashed bg-transparent px-1.5 py-0 text-[11px] font-normal text-muted-foreground
  s_902: {"display":"flex","minHeight":0,"flex":"1 1 0%","flexDirection":"column","overflow":"hidden","borderColor":"hsl(var(--border))","paddingTop":"0.5rem"}, // flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border pt-2
  s_903: {"marginBottom":"0.5rem","display":"flex","alignItems":"center","gap":"0.375rem","fontSize":"0.75rem","fontWeight":500,"textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground
  s_905: {"marginBottom":"0.5rem","display":"flex","alignItems":"center","justifyContent":"space-between","fontSize":"0.75rem","fontWeight":500,"textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // mb-2 flex items-center justify-between text-xs font-medium uppercase tracking-wider text-muted-foreground
  s_906: {"flex":"1 1 0%","overflowY":"auto"}, // flex-1 overflow-y-auto
  s_907: {"paddingRight":"0.5rem"}, // space-y-2 pr-2
  s_908: {"display":"flex","alignItems":"center","gap":"0.5rem"}, // flex items-center gap-2
  s_909: {"flexShrink":0,"color":"hsl(var(--muted-foreground))"}, // size-3.5 shrink-0 text-muted-foreground
  s_910: {"minWidth":0,"flex":"1 1 0%","overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","fontSize":"0.875rem","fontWeight":600,"color":"hsl(var(--foreground))"}, // min-w-0 flex-1 truncate text-sm font-semibold text-foreground
  s_911: {"flexShrink":0,"color":"hsl(var(--primary))"}, // size-4 shrink-0 text-primary
  s_912: {"marginTop":"0.375rem","display":"grid","gap":"0.5rem"}, // mt-1.5 grid grid-cols-3 gap-2 text-[11px]
  s_918: {"overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","fontWeight":500,"color":"hsl(var(--foreground))"}, // truncate font-medium text-foreground
  s_919: {"minWidth":0}, // min-w-0
  s_920: {"overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","color":"hsl(var(--muted-foreground))"}, // truncate text-muted-foreground
  s_921: {"overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","fontWeight":500}, // truncate font-medium text-emerald-400
  s_922: {"marginTop":"0.375rem","display":"flex","gap":"0.25rem"}, // mt-1.5 flex flex-wrap gap-1
  s_923: {"paddingInline":"0.5rem","paddingBlock":"0.125rem","color":"hsl(var(--foreground))"}, // border-transparent bg-secondary/50 px-2 py-0.5 text-[9px] text-foreground
  s_924: {"marginTop":"0.375rem"}, // mt-1.5 space-y-1
  s_925: {"display":"initial"}, // space-y-0.5
  s_926: {"display":"flex","alignItems":"center","gap":"0.25rem","color":"hsl(var(--primary))"}, // flex items-center gap-1 text-primary
  s_927: {"display":"initial"}, // size-3
  s_928: {"fontWeight":500}, // font-medium
  s_929: {"flexShrink":0,"color":"hsl(var(--muted-foreground))"}, // size-3 shrink-0 text-muted-foreground
  s_930: {"minWidth":0,"flex":"1 1 0%","overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","color":"hsl(var(--foreground))"}, // min-w-0 flex-1 truncate text-foreground
  s_931: {"flexShrink":0,"color":"hsl(var(--muted-foreground))"}, // shrink-0 text-muted-foreground
  s_932: {"display":"flex","alignItems":"center","gap":"0.25rem","paddingLeft":"0.5rem"}, // flex flex-wrap items-center gap-1 pl-2 text-[10px] text-muted-foreground/80
  s_936: {"marginTop":"0.375rem","color":"hsl(var(--muted-foreground))"}, // mt-1.5 space-y-0.5 text-[10px] text-muted-foreground
  s_937: {"display":"flex","alignItems":"center","gap":"0.25rem"}, // flex flex-wrap items-center gap-1
  s_940: {"fontFamily":"ui-monospace, monospace"}, // font-mono
  s_941: {"overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap"}, // truncate
  s_942: {"marginTop":"0.5rem","display":"flex","alignItems":"center","gap":"0.25rem"}, // mt-2 flex items-center justify-end gap-1
  s_946: {"display":"initial"}, // size-7
  s_948: {"fontSize":"0.75rem"}, // text-xs
  s_949: {"borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.75rem","paddingBlock":"1.5rem","textAlign":"center"}, // rounded-lg border border-dashed border-border px-3 py-6 text-center
  s_950: {"display":"flex","alignItems":"center","justifyContent":"center","gap":"0.375rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // flex items-center justify-center gap-1.5 text-xs text-muted-foreground
  s_953: {"marginTop":"0.25rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // mt-1 text-xs text-muted-foreground
  s_954: {"marginTop":"0.75rem","display":"flex","flexDirection":"column","alignItems":"center","gap":"0.375rem"}, // mt-3 flex flex-col items-center gap-1.5
  s_955: {"color":"hsl(var(--muted-foreground))"}, // text-[11px] text-muted-foreground
  s_956: {"display":"flex","justifyContent":"center","gap":"0.375rem"}, // flex flex-wrap justify-center gap-1.5
  s_957: {"borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","paddingInline":"0.625rem","paddingBlock":"0.25rem","fontSize":"0.75rem","color":"hsl(var(--foreground))"}, // rounded-md border border-border bg-secondary/30 px-2.5 py-1 text-xs text-foreground transition-colors hover:border-primary/40 hover:bg-primary/10
  s_959: {"marginBottom":"0.625rem","fontWeight":500,"textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // mb-2.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground
  s_960: {"display":"initial"}, // space-y-2
  s_961: {"display":"flex","alignItems":"center","gap":"0.25rem"}, // flex items-center gap-1
  s_962: {"display":"flex","flex":"1 1 0%","alignItems":"center","gap":"0.375rem","fontSize":"0.75rem","fontWeight":600,"textTransform":"uppercase","letterSpacing":"0.1em","color":"hsl(var(--muted-foreground))"}, // flex flex-1 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground
  s_965: {"borderRadius":"0.5rem","paddingInline":"0.375rem","fontWeight":600}, // rounded-full bg-orange-950/60 px-1.5 py-px text-[10px] font-semibold text-orange-300
  s_966: {"display":"flex","alignItems":"center","gap":"0.125rem","borderRadius":"0.5rem","paddingInline":"0.5rem","paddingBlock":"0.125rem","color":"hsl(var(--primary))","borderWidth":"1px","borderStyle":"solid"}, // flex items-center gap-0.5 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary border border-primary/20 hover:bg-primary/20 transition-colors
  s_967: {"display":"initial"}, // size-2.5
  s_968: {"marginTop":"0.5rem"}, // mt-2 space-y-2
  s_969: {"display":"flex","gap":"0.25rem"}, // flex flex-wrap gap-1
  s_970: {"display":"initial"}, // text-muted-foreground/60
  s_971: {"display":"flex","alignItems":"center","gap":"0.375rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // flex items-center gap-1.5 text-xs text-muted-foreground
  s_972: {"display":"initial"}, // size-3 animate-spin
  s_973: {"fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // text-xs text-muted-foreground
  s_975: {"borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))"}, // rounded-lg border border-border bg-muted/10
  s_976: {"display":"flex","width":"100%","alignItems":"center","gap":"0.5rem","paddingInline":"0.75rem","paddingBlock":"0.625rem","textAlign":"left"}, // flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/20
  s_977: {"color":"hsl(var(--primary))","flexShrink":0}, // size-3.5 text-primary shrink-0
  s_978: {"flex":"1 1 0%","fontSize":"0.75rem","fontWeight":500,"color":"hsl(var(--foreground))"}, // flex-1 text-xs font-medium text-foreground
  s_979: {"display":"inline-flex","alignItems":"center","gap":"0.25rem","borderRadius":"0.5rem","paddingInline":"0.375rem","color":"hsl(var(--muted-foreground))"}, // inline-flex items-center gap-1 rounded-full bg-muted/50 px-1.5 py-px text-[10px] text-muted-foreground
  s_980: {"display":"initial"}, // size-2.5 animate-spin
  s_981: {"borderRadius":"0.5rem","paddingInline":"0.375rem","color":"hsl(var(--muted-foreground))"}, // rounded-full bg-muted/50 px-1.5 py-px text-[10px] text-muted-foreground
  s_982: {"borderColor":"hsl(var(--border))","paddingInline":"0.75rem","paddingBlock":"0.625rem"}, // border-t border-border px-3 py-2.5 space-y-2.5
  s_983: {"textAlign":"left","color":"hsl(var(--muted-foreground))","lineHeight":1.625}, // text-left text-[11px] text-muted-foreground leading-relaxed cursor-help underline decoration-dotted underline-offset-2
  s_984: {"fontSize":"0.75rem","lineHeight":1.625}, // max-w-xs whitespace-pre-line text-xs leading-relaxed
  s_985: {"color":"hsl(var(--muted-foreground))","lineHeight":1.625}, // text-[11px] text-muted-foreground leading-relaxed
  s_986: {"display":"initial"}, // space-y-1.5
  s_987: {"display":"block"}, // relative
  s_988: {"display":"block","color":"hsl(var(--muted-foreground))"}, // pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground
  s_989: {"borderRadius":"0.375rem","borderColor":"hsl(var(--border))","fontSize":"0.875rem"}, // h-10 rounded-md border-border bg-muted/30 pl-9 pr-9 text-sm
  s_990: {"display":"block","color":"hsl(var(--muted-foreground))"}, // absolute right-3 top-1/2 z-10 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground
  s_991: {"display":"initial"}, // size-3.5
  s_992: {"display":"block","left":0,"right":0,"marginTop":"0.25rem","borderRadius":"0.375rem","borderWidth":"1px","borderStyle":"solid","borderColor":"hsl(var(--border))","padding":"0.25rem"}, // absolute left-0 right-0 top-full z-20 mt-1 rounded-md border border-border bg-popover p-1 shadow-md
  s_993: {"display":"initial"}, // space-y-5
  s_994: {"borderRadius":"0.5rem","borderWidth":"1px","borderStyle":"solid","padding":"0.75rem"}, // rounded-lg border border-primary/20 bg-primary/5 p-3
  s_995: {"display":"flex","alignItems":"center","justifyContent":"center","paddingBlock":"3rem"}, // flex items-center justify-center py-12
  s_996: {"color":"hsl(var(--muted-foreground))"}, // size-5 text-muted-foreground animate-spin
  s_997: {"display":"initial"}, // sr-only
  s_1003: {"display":"flex","flexDirection":"column","alignItems":"center","justifyContent":"center","paddingBlock":"3rem","textAlign":"center"}, // flex flex-col items-center justify-center py-12 text-center
  s_1004: {"display":"flex","height":"3rem","width":"3rem","alignItems":"center","justifyContent":"center","borderRadius":"0.5rem","marginBottom":"0.75rem"}, // flex h-12 w-12 items-center justify-center rounded-xl bg-muted/50 mb-3
  s_1005: {"color":"hsl(var(--muted-foreground))"}, // text-muted-foreground
  s_1006: {"fontSize":"0.875rem","fontWeight":500,"color":"hsl(var(--foreground))"}, // text-sm font-medium text-foreground
  s_1007: {"marginTop":"0.25rem","fontSize":"0.75rem","color":"hsl(var(--muted-foreground))"}, // mt-1 text-xs text-muted-foreground max-w-[240px]
  staticCanvas: { position: "absolute", inset: 0, width: "100%", height: "100%" },
  thumbnailCanvas: { width: "512px", height: "512px" },
  u_900: {"display":"initial"}, // backdrop-blur-md  u_901: {"display":"initial","backgroundColor":"hsl(var(--muted/20))"}, // bg-muted/20  u_902: {"display":"initial"}, // block  u_903: {"display":"initial"}, // border  u_904: {"display":"initial","borderColor":"hsl(var(--b))"}, // border-b  u_905: {"display":"initial","borderColor":"hsl(var(--border))"}, // border-border  u_906: {"display":"initial"}, // cursor-pointer  u_907: {"display":"initial"}, // duration-150  u_908: {"display":"flex"}, // flex  u_909: {"display":"initial"}, // flex-wrap  u_910: {"display":"initial"}, // focus-visible:outline-none  u_911: {"display":"initial"}, // focus-visible:ring-2  u_912: {"display":"initial"}, // focus-visible:ring-[#E8E044]  u_916: {"display":"initial"}, // gap-1  u_917: {"display":"initial"}, // gap-1.5  u_918: {"display":"initial"}, // gap-2  u_919: {"display":"initial"}, // gap-2.5  u_920: {"display":"initial"}, // gap-x-3  u_921: {"display":"initial"}, // gap-y-1  u_922: {"display":"initial"}, // h-10  u_923: {"display":"initial"}, // hover:bg-muted/50  u_924: {"display":"initial"}, // hover:bg-secondary/40  u_925: {"display":"initial"}, // hover:scale-110  u_926: {"display":"initial"}, // hover:text-foreground  u_927: {"display":"inline-flex"}, // inline-flex  u_928: {"display":"initial"}, // items-center  u_929: {"display":"initial"}, // justify-center  u_930: {"display":"initial"}, // leading-relaxed  u_931: {"display":"initial"}, // ml-0.5  u_932: {"display":"initial"}, // mr-2  u_933: {"display":"initial"}, // p-1  u_934: {"display":"initial"}, // px-1  u_935: {"display":"initial"}, // px-1.5  u_936: {"display":"initial"}, // px-2  u_937: {"display":"initial"}, // px-2.5  u_938: {"display":"initial"}, // px-3  u_939: {"display":"initial"}, // px-3.5  u_940: {"display":"initial"}, // px-4  u_941: {"display":"initial"}, // py-0.5  u_942: {"display":"initial"}, // py-1  u_943: {"display":"initial"}, // py-1.5  u_944: {"display":"initial"}, // py-2  u_945: {"display":"initial"}, // py-2.5  u_946: {"display":"initial"}, // py-3  u_947: {"display":"initial"}, // py-px  u_948: {"display":"initial"}, // ring-1  u_949: {"display":"initial"}, // ring-black/20  u_950: {"display":"initial"}, // ring-inset  u_951: {"display":"initial","borderRadius":"0.25rem"}, // rounded  u_952: {"display":"initial"}, // rounded-full  u_953: {"display":"initial"}, // rounded-lg  u_954: {"display":"initial"}, // rounded-md  u_955: {"display":"initial"}, // rounded-sm  u_960: {"display":"initial","width":"1.25rem","height":"1.25rem"}, // size-5  u_961: {"display":"initial"}, // tabular-nums  u_962: {"display":"initial","fontSize":"inherit"}, // text-[10px]  u_963: {"display":"initial","fontSize":"inherit"}, // text-[11px]  u_964: {"display":"initial","fontSize":"inherit"}, // text-foreground  u_965: {"display":"initial","fontSize":"inherit"}, // text-left  u_969: {"display":"initial"}, // transition-all  u_970: {"display":"initial"}, // transition-colors  u_971: {"display":"initial"}, // transition-transform
});
