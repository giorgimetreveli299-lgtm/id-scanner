export type FaceBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Shown when the back upload looks like a front (face / signature). */
export const BACK_SIDE_REQUIRED_ERROR =
  "Please upload back side of driver license.";

/** Shown when the front upload looks like a back (QR / back text, no face). */
export const FRONT_SIDE_REQUIRED_ERROR =
  "Please upload front side of driver license.";
