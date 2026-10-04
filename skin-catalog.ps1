# Stable ids keep saved preferences compatible across upgrades.
# All previews and runtime sprites are bundled local images, never remote URLs.
$script:SkinCatalog = @(
  [pscustomobject]@{ id = 'default'; name = '海蓝鲸鱼娘' },
  [pscustomobject]@{ id = 'night'; name = '夜航科技娘' },
  [pscustomobject]@{ id = 'snow'; name = '雪绒鲸娘' },
  [pscustomobject]@{ id = 'mint'; name = '薄荷茶娘' },
  [pscustomobject]@{ id = 'cherry'; name = '樱桃汽水娘' },
  [pscustomobject]@{ id = 'star'; name = '星砂魔法娘' }
)
