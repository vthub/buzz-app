import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { AvatarEditor } from "../profiles/AvatarEditor";
import { avatarPictureError } from "../profiles/avatar-upload";
import type { PersonalProfile } from "./service";
import { PROFILE_ABOUT_MAX_LENGTH } from "./service";
import { Textarea } from "../../shared/design-system/ui/Textarea";

export function profilesEqual(left: PersonalProfile, right: PersonalProfile) {
  return (
    left.name === right.name &&
    left.picture === right.picture &&
    (left.about ?? "") === (right.about ?? "")
  );
}

export function canSaveProfile(profile: PersonalProfile) {
  return (
    !!profile.name.trim() &&
    !avatarPictureError(profile.picture) &&
    (profile.about?.length ?? 0) <= PROFILE_ABOUT_MAX_LENGTH
  );
}

export function ProfileFields({
  profile,
  onChange,
  disabled = false,
  community,
  onBusyChange,
  showAvatar = true,
  autoFocus = false,
}: {
  profile: PersonalProfile;
  onChange(profile: PersonalProfile): void;
  disabled?: boolean;
  community?: string | undefined;
  onBusyChange?(busy: boolean): void;
  showAvatar?: boolean;
  /** Focuses the display name on mount, for pages whose only task is this form. */
  autoFocus?: boolean;
}) {
  return (
    <div className="grid gap-4">
      {showAvatar && (
        <AvatarEditor
          value={profile.picture}
          name={profile.name}
          community={community}
          disabled={disabled}
          onBusyChange={onBusyChange}
          onChange={(picture) => onChange({ ...profile, picture })}
        />
      )}
      <Field label="Display name">
        <Input
          autoComplete="nickname"
          autoFocus={autoFocus}
          required
          disabled={disabled}
          value={profile.name}
          maxLength={100}
          onChange={(event) =>
            onChange({ ...profile, name: event.target.value })
          }
        />
      </Field>
      <Field
        label="Profile description (optional)"
        description={`${profile.about?.length ?? 0} of ${PROFILE_ABOUT_MAX_LENGTH} characters`}
        error={
          (profile.about?.length ?? 0) > PROFILE_ABOUT_MAX_LENGTH
            ? `Shorten the description to ${PROFILE_ABOUT_MAX_LENGTH} characters before saving.`
            : undefined
        }
      >
        <Textarea
          rows={3}
          disabled={disabled}
          value={profile.about ?? ""}
          onChange={(event) =>
            onChange({ ...profile, about: event.target.value })
          }
        />
      </Field>
    </div>
  );
}
