import * as stylex from "@stylexjs/stylex";
import { colors, motion, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
export const styles = stylex.create({
 root:{fontSize:text.sizeXs, lineHeight: text.lineXs}, empty:{paddingBlock: space.s2,fontSize:text.sizeXs, lineHeight: text.lineXs,fontStyle:"italic",color:colors.inkFaint}, nullValue:{fontStyle:"italic",color:colors.inkFaint}, bool:{display:"inline-flex",alignItems:"center",paddingInline: space.s1_5,paddingBlock:"1px",fontSize:text.sizeMicro,fontWeight:text.weightMedium}, boolTrue:{backgroundColor:colors.positiveWash,color:colors.positive}, boolFalse:{backgroundColor:colors.muted,color:colors.mutedForeground}, mono:{fontFamily:text.fontMono,color:colors.text}, /** `text-foreground break-words` — body face, not the code face. */ plain:{color:colors.text,overflowWrap:"break-word"}, uuid:{fontFamily:text.fontMono,color:colors.inkSecondary,wordBreak:"break-all",fontSize:text.sizeMicro}, inline:{display:"inline-flex",alignItems:"center",gap:space.s1}, action:{display:"inline-flex",width:"1rem",height:"1rem",alignItems:"center",justifyContent:"center",color:colors.inkFaint,transitionProperty:"color,background-color",transitionDuration:motion.durStandard,":hover":{color:colors.info,backgroundColor:colors.infoWash}}, actionSelect:{":hover":{color:colors.primary,backgroundColor:colors.accentWash}}, row:{display:"flex",alignItems:"baseline",gap:space.s2,paddingBlock:space.s0_5}, label:{flexShrink:0,color:colors.mutedForeground}, labelXs:{flexShrink:0,color:colors.mutedForeground,fontSize:text.sizeXs, lineHeight: text.lineXs}, header:{display:"flex",width:"100%",alignItems:"baseline",gap:space.s1_5,paddingBlock:space.s0_5,fontSize:text.sizeXs, lineHeight: text.lineXs,transitionProperty:"background-color",transitionDuration:motion.durStandard,":hover":{backgroundColor:"rgba(148,163,184,.3)"}}, chevron:{width:".75rem",height:".75rem",flexShrink:0,color:colors.mutedForeground,transitionProperty:"transform",transitionDuration:motion.durStandard,marginTop:space.s0_5}, chevronOpen:{transform:"rotate(90deg)"}, preview:{fontFamily:text.fontMono,fontSize:text.sizeMicro,color:colors.inkFaint}, count:{fontFamily:text.fontMono,fontSize:text.sizeMicro,color:colors.inkFaint}, divider:{borderTopWidth:stroke.hairline, borderTopStyle:"solid", borderTopColor:colors.hairline,marginBlock:space.s0_5}, more:{paddingBlock:space.s0_5,fontSize:text.sizeMicro,color:colors.primary,transitionProperty:"color",transitionDuration:motion.durStandard,":hover":{color:colors.accent}},
  // size-3
  eyeIcon: {
    width: space.s3,
    height: space.s3,
  },
  // size-3
  locatefixedIcon: {
    width: space.s3,
    height: space.s3,
  },
});